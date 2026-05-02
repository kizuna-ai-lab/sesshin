// This file is a placeholder. Task 4 renamed the wire protocol from
// session.confirmation → session.prompt-request and removed the
// supporting store signals; Task 8 will replace this component with
// InteractionPanel. Until then, keep the file compilable (no broken
// imports) so tsc --noEmit / IDEs don't flag the package.
import type { WsClient } from '../ws-client.js';
export function ConfirmationPanel(_props: { ws: WsClient; sessionId: string }) {
  return null;
}
