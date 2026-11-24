import type { Conversation, Peer, Profile } from "./protocol.js";

export const initialProfile: Profile = { mode: "offline", config: {}, externalHub: "" };

export type MemberRecord = {
  peer: Peer; profile: Profile; conversations: Conversation[]; active?: string; cwd?: string;
};
export type MemberIndex = { version: 2; externalHub: string; members: MemberRecord[] };
type LegacyIndex = { profile: Profile; conversations: Conversation[]; active?: string };

export function peerId(input: string): Peer {
  if (typeof input !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.trim())) {
    throw new Error("成员 ID 须为 1 至 64 位，以英文字母或数字开头，可使用点、短横线和下划线。");
  }
  return input.trim().toLowerCase();
}

export function migrateIndex(old: LegacyIndex): MemberIndex {
  const next: MemberIndex = { version: 2, externalHub: old.profile.externalHub, members: [] };
  for (const group of old.conversations) {
    for (const session of group.members) {
      const peer = peerId(session.peer ?? "local");
      let record = next.members.find(record => record.peer === peer);
      if (!record) {
        record = { peer, profile: old.profile, conversations: [], cwd: session.cwd };
        next.members.push(record);
      }
      record.conversations.push({ ...group, members: [{ ...session, peer }] });
      if (session.id === old.active) {
        record.active = session.id;
        record.cwd = session.cwd;
      }
    }
  }
  if (!next.members.length) next.members.push({ peer: "local", profile: old.profile, conversations: [] });
  for (const record of next.members) record.active ??= record.conversations[0]?.members[0].id;
  return next;
}
