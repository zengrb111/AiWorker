import { jsonOk } from "@/lib/http";
import { clearSession } from "@/lib/session";

export async function POST() {
  clearSession();
  return jsonOk({ loggedOut: true });
}
