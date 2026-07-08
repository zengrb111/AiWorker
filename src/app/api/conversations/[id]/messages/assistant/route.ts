import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

type AssistantBody = {
  content?: string;
};

/** POST /api/conversations/[id]/messages/assistant — save a partial assistant message (stop case). */
export async function POST(request: Request, context: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<AssistantBody>(request);
  const content = body.content?.trim() ?? "";
  if (!content) {
    return jsonError("消息内容不能为空。");
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: context.params.id, userId: user.id }
  });
  if (!conversation) {
    return jsonError("对话不存在。", 404);
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content
    }
  });

  return jsonOk({ message });
}
