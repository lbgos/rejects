import { useEffect } from "react";

import { collapseExpandedComposerCursor } from "../../composer-logic";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { useStableCallback } from "../../hooks/useStableCallback";
import { stripInlineContextReferences } from "../../lib/composerContextReferences";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { takeUnsentFromClosedPages } from "./sendOrder";

/**
 * Puts back the text of messages a closed or reloaded page never got to the server, oldest
 * first and ahead of the current draft. Their attachments are gone with the page, so the toast
 * asks for them again.
 */
export function useUnsentMessageRecovery(input: {
  readonly threadKey: string;
  /** Null until the server thread has loaded. */
  readonly serverMessages: ReadonlyArray<{ readonly id: string }> | null;
  readonly draftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
}) {
  const { threadKey, serverMessages, draftTarget, promptRef, composerRef } = input;
  const loaded = serverMessages !== null;
  const recover = useStableCallback((key: string) => {
    const onServer = new Set(serverMessages?.map((message) => message.id));
    const unsent = takeUnsentFromClosedPages(key, (messageId) => onServer.has(messageId));
    if (unsent.length === 0) return;
    const store = useComposerDraftStore.getState();
    const prompt = [
      // Chips for attachments and contexts would point at records the page took with it.
      ...unsent.map((entry) =>
        stripInlineContextReferences(entry.draftText)
          .replace(/[ \t]{2,}/g, " ")
          .trim(),
      ),
      store.getComposerDraft(draftTarget)?.prompt ?? "",
    ]
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
    store.setPrompt(draftTarget, prompt);
    promptRef.current = prompt;
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(prompt, prompt.length),
      prompt,
    });
    const files = unsent.reduce((count, entry) => count + entry.attachmentCount, 0);
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title:
          unsent.length === 1
            ? "A message was not sent"
            : `${unsent.length} messages were not sent`,
        description: `The page closed before ${unsent.length === 1 ? "it" : "they"} went out. The text is back in the composer${files === 0 ? "." : `; attach ${files === 1 ? "the file" : `the ${files} files`} again.`}`,
        timeout: 0,
      }),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the unsent-message journal in localStorage once the thread's server messages are known
  useEffect(() => {
    if (loaded) recover(threadKey);
  }, [threadKey, loaded, recover]);
}
