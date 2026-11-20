import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;

export type Peer = {
  peer_id: string;
  created_at: string;
  last_seen_at: string | null;
};

export type Message = {
  message_id: string;
  sender_peer_id: string;
  content: string;
  reply_to: string | null;
  created_at: string;
  seq: number;
};

export type PeerStatus =
  | "received"
  | "thinking"
  | "working"
  | "pushing"
  | "idle"
  | "interrupted"
  | "offline";

export type PeerState = {
  peer_id: string;
  turn_id: string;
  raw_intent: string | null;
  intent_summary: string | null;
  planned_paths: string[];
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  status: PeerStatus;
  updated_at: string;
  expires_at: string;
  is_self?: boolean;
};

export type BeginTurnInput = {
  turnId: string;
  rawIntent: string;
  cwd?: string | undefined;
  repository?: string | undefined;
  branch?: string | undefined;
  ttlSeconds: number;
};

export type UpdateStateInput = {
  turnId: string;
  intentSummary?: string | undefined;
  plannedPaths?: string[] | undefined;
  cwd?: string | undefined;
  repository?: string | undefined;
  branch?: string | undefined;
  status?: PeerStatus | undefined;
  ttlSeconds?: number | undefined;
};

export type SendResult = {
  message_id: string;
  sender_peer_id: string;
  recipients: string[];
  seqs: number[];
  created_at: string;
};

export function validatePeerId(peerId: string): string {
  if (!PEER_ID_PATTERN.test(peerId)) {
    throw new Error(
      "peer id must be 1-64 characters using letters, numbers, dot, underscore, or hyphen",
    );
  }
  return peerId;
}

export class TeamHubStore {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS peers (
        peer_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        sender_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
        content TEXT NOT NULL,
        reply_to TEXT REFERENCES messages(message_id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        recipient_peer_id TEXT NOT NULL REFERENCES peers(peer_id),
        read_at TEXT,
        UNIQUE(message_id, recipient_peer_id)
      );

      CREATE INDEX IF NOT EXISTS deliveries_recipient_seq
        ON deliveries(recipient_peer_id, seq);

      CREATE TABLE IF NOT EXISTS peer_states (
        peer_id TEXT PRIMARY KEY REFERENCES peers(peer_id),
        turn_id TEXT NOT NULL,
        raw_intent TEXT,
        intent_summary TEXT,
        planned_paths TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        repository TEXT,
        branch TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS peer_states_expires_at
        ON peer_states(expires_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  registerPeer(peerId: string): Peer {
    const normalized = validatePeerId(peerId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO peers(peer_id, created_at, last_seen_at)
         VALUES (?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(normalized, now, now);
    return this.getPeer(normalized);
  }

  listPeers(requesterPeerId: string): Array<Peer & { is_self: boolean }> {
    this.touchPeer(requesterPeerId);
    const rows = this.db
      .prepare(
        `SELECT peer_id, created_at, last_seen_at
         FROM peers
         ORDER BY peer_id`,
      )
      .all() as unknown as Peer[];

    return rows.map((row) => ({
      ...row,
      is_self: row.peer_id === requesterPeerId,
    }));
  }

  sendMessage(
    senderPeerId: string,
    recipients: string[],
    content: string,
    replyTo?: string,
  ): SendResult {
    const sender = validatePeerId(senderPeerId);
    this.touchPeer(sender);

    if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_BYTES) {
      throw new Error("message exceeds 64 KiB");
    }
    if (!content.trim()) {
      throw new Error("message cannot be empty");
    }

    const selected = this.resolveRecipients(sender, recipients);
    if (selected.length === 0) {
      throw new Error("no recipients remain after excluding the sender");
    }

    if (replyTo !== undefined) {
      const parent = this.db
        .prepare("SELECT message_id FROM messages WHERE message_id = ?")
        .get(replyTo);
      if (!parent) {
        throw new Error(`reply_to message does not exist: ${replyTo}`);
      }
    }

    const messageId = `msg_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const recipient of selected) {
        this.ensureAddressablePeer(recipient);
      }
      this.db
        .prepare(
          `INSERT INTO messages(message_id, sender_peer_id, content, reply_to, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(messageId, sender, content, replyTo ?? null, createdAt);

      const insertDelivery = this.db.prepare(
        `INSERT INTO deliveries(message_id, recipient_peer_id)
         VALUES (?, ?)`,
      );
      const seqs = selected.map((recipient) => {
        const result = insertDelivery.run(messageId, recipient);
        return Number(result.lastInsertRowid);
      });
      this.db.exec("COMMIT");

      return {
        message_id: messageId,
        sender_peer_id: sender,
        recipients: selected,
        seqs,
        created_at: createdAt,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  beginTurn(peerId: string, input: BeginTurnInput): PeerState {
    const normalized = validatePeerId(peerId);
    const turnId = validateTurnId(input.turnId);
    const rawIntent = input.rawIntent.trim();
    if (!rawIntent) {
      throw new Error("raw_intent cannot be empty");
    }
    if (rawIntent.length > 8_000) {
      throw new Error("raw_intent exceeds 8000 characters");
    }

    this.touchPeer(normalized);
    const now = new Date();
    const updatedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + normalizeTtl(input.ttlSeconds) * 1_000,
    ).toISOString();
    const current = this.getState(normalized);

    if (!current || current.turn_id !== turnId) {
      this.db
        .prepare(
          `INSERT INTO peer_states(
             peer_id,
             turn_id,
             raw_intent,
             intent_summary,
             planned_paths,
             cwd,
             repository,
             branch,
             status,
             updated_at,
             expires_at
           )
           VALUES (?, ?, ?, NULL, '[]', ?, ?, ?, 'received', ?, ?)
           ON CONFLICT(peer_id) DO UPDATE SET
             turn_id = excluded.turn_id,
             raw_intent = excluded.raw_intent,
             intent_summary = NULL,
             planned_paths = '[]',
             cwd = excluded.cwd,
             repository = excluded.repository,
             branch = excluded.branch,
             status = 'received',
             updated_at = excluded.updated_at,
             expires_at = excluded.expires_at`,
        )
        .run(
          normalized,
          turnId,
          rawIntent,
          input.cwd ?? null,
          input.repository ?? null,
          input.branch ?? null,
          updatedAt,
          expiresAt,
        );
    } else {
      this.db
        .prepare(
          `UPDATE peer_states
           SET raw_intent = ?,
               cwd = COALESCE(?, cwd),
               repository = COALESCE(?, repository),
               branch = COALESCE(?, branch),
               updated_at = ?,
               expires_at = ?
           WHERE peer_id = ? AND turn_id = ?`,
        )
        .run(
          rawIntent,
          input.cwd ?? null,
          input.repository ?? null,
          input.branch ?? null,
          updatedAt,
          expiresAt,
          normalized,
          turnId,
        );
    }

    return this.requireState(normalized);
  }

  updateState(peerId: string, input: UpdateStateInput): PeerState {
    const normalized = validatePeerId(peerId);
    const turnId = validateTurnId(input.turnId);
    const current = this.getState(normalized);
    if (!current) {
      throw new Error("no turn state exists; call team_begin_turn first");
    }
    if (current.turn_id !== turnId) {
      throw new Error(
        `turn_id does not match the active Team Hub turn for ${normalized}`,
      );
    }

    const summary = input.intentSummary?.trim();
    if (summary !== undefined && summary.length > 4_000) {
      throw new Error("intent_summary exceeds 4000 characters");
    }
    if (
      input.plannedPaths !== undefined &&
      input.plannedPaths.some((path) => !path.trim())
    ) {
      throw new Error("planned_paths cannot contain empty paths");
    }

    const now = new Date();
    const updatedAt = now.toISOString();
    const expiresAt =
      input.ttlSeconds === undefined
        ? current.expires_at
        : new Date(
            now.getTime() + normalizeTtl(input.ttlSeconds) * 1_000,
          ).toISOString();
    const plannedPaths = JSON.stringify(
      input.plannedPaths
        ? [...new Set(input.plannedPaths.map((path) => path.trim()))]
        : current.planned_paths,
    );

    this.db
      .prepare(
        `UPDATE peer_states
         SET intent_summary = COALESCE(?, intent_summary),
             planned_paths = ?,
             cwd = COALESCE(?, cwd),
             repository = COALESCE(?, repository),
             branch = COALESCE(?, branch),
             status = COALESCE(?, status),
             updated_at = ?,
             expires_at = ?
         WHERE peer_id = ? AND turn_id = ?`,
      )
      .run(
        summary ?? null,
        plannedPaths,
        input.cwd ?? null,
        input.repository ?? null,
        input.branch ?? null,
        input.status ?? null,
        updatedAt,
        expiresAt,
        normalized,
        turnId,
      );

    return this.requireState(normalized);
  }

  getActiveStates(
    requesterPeerId: string,
    includeStale = false,
  ): Array<PeerState & { is_self: boolean }> {
    const requester = validatePeerId(requesterPeerId);
    this.touchPeer(requester);
    const rows = this.db
      .prepare(
        `SELECT
           peer_id,
           turn_id,
           raw_intent,
           intent_summary,
           planned_paths,
           cwd,
           repository,
           branch,
           status,
           updated_at,
           expires_at
         FROM peer_states
         ORDER BY peer_id`,
      )
      .all() as unknown as StateRow[];
    const now = new Date().toISOString();
    return rows
      .filter((row) => includeStale || row.expires_at > now)
      .map((row) => ({
        ...stateFromRow(row),
        is_self: row.peer_id === requester,
      }));
  }

  readMessages(peerId: string, limit: number): Message[] {
    const normalized = validatePeerId(peerId);
    this.touchPeer(normalized);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT
             m.message_id,
             m.sender_peer_id,
             m.content,
             m.reply_to,
             m.created_at,
             d.seq
           FROM deliveries d
           JOIN messages m ON m.message_id = d.message_id
           WHERE d.recipient_peer_id = ? AND d.read_at IS NULL
           ORDER BY d.seq
           LIMIT ?`,
        )
        .all(normalized, boundedLimit) as unknown as Message[];

      if (rows.length > 0) {
        const now = new Date().toISOString();
        const markRead = this.db.prepare(
          `UPDATE deliveries
           SET read_at = ?
           WHERE recipient_peer_id = ? AND seq = ? AND read_at IS NULL`,
        );
        for (const row of rows) {
          markRead.run(now, normalized, row.seq);
        }
      }

      this.db.exec("COMMIT");
      return rows;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private touchPeer(peerId: string): void {
    const normalized = validatePeerId(peerId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO peers(peer_id, created_at, last_seen_at)
         VALUES (?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(normalized, now, now);
  }

  private ensureAddressablePeer(peerId: string): void {
    const normalized = validatePeerId(peerId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO peers(peer_id, created_at, last_seen_at)
         VALUES (?, ?, NULL)
         ON CONFLICT(peer_id) DO NOTHING`,
      )
      .run(normalized, now);
  }

  private getPeer(peerId: string): Peer {
    const row = this.db
      .prepare(
        `SELECT peer_id, created_at, last_seen_at
         FROM peers
         WHERE peer_id = ?`,
      )
      .get(peerId) as unknown as Peer | undefined;
    if (!row) {
      throw new Error(`unknown peer: ${peerId}`);
    }
    return row;
  }

  private getState(peerId: string): PeerState | undefined {
    const row = this.db
      .prepare(
        `SELECT
           peer_id,
           turn_id,
           raw_intent,
           intent_summary,
           planned_paths,
           cwd,
           repository,
           branch,
           status,
           updated_at,
           expires_at
         FROM peer_states
         WHERE peer_id = ?`,
      )
      .get(peerId) as unknown as StateRow | undefined;
    return row ? stateFromRow(row) : undefined;
  }

  private requireState(peerId: string): PeerState {
    const state = this.getState(peerId);
    if (!state) {
      throw new Error(`peer state does not exist: ${peerId}`);
    }
    return state;
  }

  private resolveRecipients(sender: string, recipients: string[]): string[] {
    const expanded =
      recipients.includes("*")
        ? (this.db.prepare("SELECT peer_id FROM peers").all() as unknown as Array<{
            peer_id: string;
          }>).map((row) => row.peer_id)
        : recipients;

    return [...new Set(expanded.map(validatePeerId))].filter(
      (recipient) => recipient !== sender,
    );
  }
}

type StateRow = {
  peer_id: string;
  turn_id: string;
  raw_intent: string | null;
  intent_summary: string | null;
  planned_paths: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  status: PeerStatus;
  updated_at: string;
  expires_at: string;
};

function stateFromRow(row: StateRow): PeerState {
  let plannedPaths: string[];
  try {
    const parsed = JSON.parse(row.planned_paths) as unknown;
    plannedPaths = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    plannedPaths = [];
  }
  return {
    peer_id: row.peer_id,
    turn_id: row.turn_id,
    raw_intent: row.raw_intent,
    intent_summary: row.intent_summary,
    planned_paths: plannedPaths,
    cwd: row.cwd,
    repository: row.repository,
    branch: row.branch,
    status: row.status,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

function validateTurnId(turnId: string): string {
  const normalized = turnId.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error("turn_id must be between 1 and 256 characters");
  }
  return normalized;
}

function normalizeTtl(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("ttl_seconds must be finite");
  }
  return Math.max(30, Math.min(Math.trunc(value), 24 * 60 * 60));
}
