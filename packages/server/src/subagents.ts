import { ResponseError } from "vscode-jsonrpc";
import type { ConversationId } from "@harness/protocol";
import type { HarnessRpcSession } from "@harness/service";
import {
  ancestorChain,
  conversationStatus,
  childrenPage,
  spawnMark,
  subagentsInspectRequest,
  subagentsListRequest,
} from "@harness/subagents";

export function registerSubagentServer(session: HarnessRpcSession): void {
  const service = session.host.service;
  session.registerAncestry(async (id) =>
    (await ancestorChain(service, id)).map((member) => member.id),
  );
  const spawn = (id: string) => spawnMark(service, id as ConversationId);
  const children = (id: string, limit: number, cursor?: { createdAt: number; id: string }) =>
    childrenPage(service, id as ConversationId, limit, cursor);
  session.registerWriteCheck(async (id) => {
    if ((await service.getPluginState("subagents", id, "spawn")) !== undefined)
      throw new ResponseError(-32000, "Subagent conversations are read-only");
  });
  session.onRequest(subagentsInspectRequest, async ({ conversationId }) => {
    const mark = await spawn(conversationId);
    if (!mark) return null;
    const chain = await ancestorChain(service, conversationId as ConversationId);
    return {
      name: mark.name ?? mark.agent,
      slug: mark.slug ?? conversationId,
      agent: mark.agent,
      ancestors: chain.slice(0, -1).map(({ id, name }) => ({ id, name })),
    };
  });
  session.onRequest(subagentsListRequest, async ({ conversationId, limit, cursor }) => {
    const live = service.conversationTreeState(conversationId as ConversationId);
    // Scope counts to this branch, including nested children. Parent links are
    // memoized within this request; no historical conversations are loaded.
    const ancestors = new Map<string, string | undefined>();
    const parentOf = async (id: string) => {
      if (!ancestors.has(id)) ancestors.set(id, (await spawn(id))?.parent.conversationId);
      return ancestors.get(id);
    };
    const counts = new Map<string, number>();
    for (const member of live) {
      if (member.status !== "running" || member.conversation.id === conversationId) continue;
      if ((await service.getLatestTurn(member.conversation.id))?.status !== "running") continue;
      const seen = new Set<string>();
      let id: string | undefined = member.conversation.id;
      while (id !== undefined) {
        if (seen.has(id)) throw new Error("Subagent parent cycle");
        seen.add(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        id = await parentOf(id);
      }
    }
    const records = await children(conversationId, limit + 1, cursor ?? undefined);
    const page = records.slice(0, limit);
    return {
      children: await Promise.all(
        page.map(async (record) => {
          const mark = await spawn(record.id);
          if (!mark) throw new Error("Scoped subagent is missing its spawn mark");
          return {
            id: record.id,
            name: mark.name ?? mark.agent,
            slug: mark.slug ?? record.id,
            agent: mark.agent,
            status: await conversationStatus(service, record.id),
            running: counts.get(record.id) ?? 0,
            hasChildren: (await children(record.id, 1)).length > 0,
          };
        }),
      ),
      running: counts.get(conversationId) ?? 0,
      nextCursor:
        records.length > limit ? { createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id } : null,
    };
  });
}
