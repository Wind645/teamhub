import type { Event } from "../../toy-harness/src/journal.js";
import type { ModelConfig } from "../../toy-harness/src/model.js";
import type { Config } from "../../toy-harness/src/session.js";

export type Peer = string;
export type Profile = {
  mode: "offline" | "model";
  config: Omit<Config, "hooks" | "teamhub">;
  externalHub: string;
};
export type Conversation = {
  id: string; created: number; members: Member[];
};
export type Member = {
  id: string; cwd: string; peer?: Peer; directory?: string;
};
export type ApprovalKey = { turn: string; request: number; callId: string };
export type Pending = ApprovalKey & { name: string; args: Record<string, unknown> };
export type Issue = { kind: "credential" | "model" | "hub" | "session"; detail: string };
export type SessionState = {
  events: Event[]; phase: "idle" | "starting" | "ready"; pending?: Pending; issue?: Issue;
};
export type Snapshot = {
  peer: Peer;
  profile: Profile; school: ModelConfig; canStoreKey: boolean; hasKey: boolean;
  petsEnabled: boolean;
  conversations: Conversation[]; sessions: Record<string, SessionState>; active?: string;
};
export type LocalMember = { peer: Peer; cwd?: string; open: boolean };
export type Command =
  | { type: "submit"; text: string } | { type: "steer"; text: string }
  | { type: "approve"; key: ApprovalKey; allow: boolean }
  | { type: "interrupt" | "resume" | "close" | "peers" }
  | { type: "rollback"; seq: number };
export type WorkerRequest =
  | { type: "init"; member: Member; directory: string; exists: boolean; profile: Profile; teamUrl?: string; hookPath: string; key?: string }
  | { type: "command"; id: number; command: Command };
export type WorkerMessage =
  | { type: "ready"; events: Event[] }
  | { type: "event"; event: Event }
  | { type: "pending"; pending?: Pending }
  | { type: "fatal"; issue: Issue }
  | { type: "response"; id: number; result?: unknown; issue?: Issue };
export type Api = {
  members(): Promise<LocalMember[]>;
  openMember(peer: string): Promise<void>;
  memberPicker(): Promise<void>;
  setPetsEnabled(enabled: boolean): Promise<void>;
  state(): Promise<Snapshot>;
  subscribe(callback: (state: Snapshot) => void): () => void;
  folder(): Promise<string | undefined>;
  create(path: string, text: string): Promise<{ id: string } | { issue: Issue }>;
  importSession(): Promise<string | undefined>;
  select(id?: string): Promise<void>;
  command(id: string, command: Command): Promise<unknown>;
  retry(id: string): Promise<void>;
  peers(id: string): Promise<unknown>;
  importProfile(): Promise<Profile | undefined>;
  saveProfile(profile: Profile, key?: string, persist?: boolean, clear?: boolean): Promise<void>;
  artifact(id: string, seq: number, action: "open" | "show"): Promise<void>;
  confirm(title: string, detail: string): Promise<boolean>;
};
