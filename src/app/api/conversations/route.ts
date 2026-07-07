import { jsonError, jsonOk, readJson } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

type CreateConversationBody = {
  title?: string;
};

export async function GET() {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const conversations = await prisma.conversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
  return jsonOk({ conversations });
}

export async function POST(request: Request) {
  const user = await requireUser();
  if (!user) {
    return jsonError("未登录。", 401);
  }

  const body = await readJson<CreateConversationBody>(request);
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      title: body.title?.trim() || "新的对话",
      messages: {
        create: {
          role: "ASSISTANT",
          content: "你好，请告诉我你想让 AI 员工完成什么任务。"
        }
      }
    },
    include: {
      messages: true
    }
  });

  return jsonOk({ conversation });
}
