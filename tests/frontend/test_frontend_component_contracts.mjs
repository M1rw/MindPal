import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const componentSources = {
  chatInput: 'frontend/src/components/chat/input/ChatInput.tsx',
  chatInputActions: 'frontend/src/components/chat/input/ChatInputActions.tsx',
  chatCanvas: 'frontend/src/components/chat/canvas/ChatCanvas.tsx',
  chatCanvasMessage: 'frontend/src/components/chat/canvas/ChatCanvasMessage.tsx',
  chatMemoryReceipt: 'frontend/src/components/chat/canvas/ChatMemoryReceipt.tsx',
  chatVoiceReceipt: 'frontend/src/components/chat/canvas/ChatVoiceReceipt.tsx',
  chatApi: 'frontend/src/services/api/chat.ts',
  memoryInspector: 'frontend/src/components/memory/MemoryInspector.tsx',
  memoryInspectorHeader: 'frontend/src/components/memory/MemoryInspectorHeader.tsx',
  memoryApi: 'frontend/src/services/api/memory.ts',
  authModal: 'frontend/src/components/auth/AuthModal.tsx',
  settingsModal: 'frontend/src/components/settings/SettingsModal.tsx',
  historyModal: 'frontend/src/components/chat/history/ChatHistoryModal.tsx',
  settingsSidebar: 'frontend/src/components/settings/SettingsSidebar.tsx',
  header: 'frontend/src/components/ui/Header.tsx',
  envTag: 'frontend/src/components/ui/EnvTag.tsx',
  appShell: 'frontend/src/App.tsx',
};

describe('Frontend component contracts', () => {
  it('keeps the chat input send contract explicit', async () => {
    const source = await readSource(componentSources.chatInput);
    assert.match(source, /export const ChatInput = forwardRef/);
    assert.match(source, /Ask MindPal/);
    assert.match(source, /Listening\.\.\./);
    assert.match(source, /spellCheck=\{false\}/);
    assert.match(source, /ApiClient\.streamChat/);
    assert.match(source, /captureMemoryReceipt/);
    assert.match(source, /Please retry this message/);
    assert.match(source, /model: activeModel/);
    assert.match(source, /onCloseSelector/);
    assert.match(source, /if \(isGenerating\) setSelectorOpen\(false\)/);
    assert.match(source, /ComposerNotice/);
    assert.match(source, /composerDraft/);
    assert.match(source, /thinkingMounted && 'chat-composer--thinking'/);
    assert.match(source, /chat-composer--thinking-out/);
    assert.match(source, /chat-composer--dictating/);
    assert.match(source, /chat-composer__body/);
    assert.match(source, /chat-composer__row/);
    assert.match(source, /chat-composer__idle-actions--expand/);
    assert.match(source, /chat-composer--expanded/);
    assert.match(source, /chat-composer--editing/);
    assert.match(source, /isEditingThread/);
    assert.match(source, /Maximize2/);
    assert.match(source, /hover:bg-surface-elevated/);
    assert.match(source, /custom-scrollbar/);
    assert.doesNotMatch(source, /fieldFade/);
    assert.doesNotMatch(source, /chat-composer__body--fade/);
    assert.doesNotMatch(source, /isComposerTall/);
    assert.match(source, /chat-composer__idle-actions/);
    assert.match(source, /chat-composer__field-wrap/);
    assert.match(source, /chat-composer__dictate/);
    assert.doesNotMatch(source, /chat-composer--tall/);
    assert.doesNotMatch(source, /isComposerTall/);
    assert.match(source, /useOverlayPresence\(\s*isGenerating/);
    assert.match(source, /--composer-think-from/);
    assert.doesNotMatch(source, /shadow-card/);
    assert.doesNotMatch(source, /shadow-glow-brand/);
    assert.doesNotMatch(source, /GlobalLoader/);

    const notice = await readSource('frontend/src/components/chat/input/ComposerNotice.tsx');
    assert.match(notice, /wellness companion, not a medical service/);
    assert.match(notice, /resolveComposerActivity/);
    assert.match(notice, /guest chats stay on this device/i);
    assert.match(notice, /not a diagnosis/);
    assert.match(notice, /composer-notice--out/);
    assert.match(notice, /Sending this replaces later replies/);
    assert.doesNotMatch(notice, /guarantees privacy/i);
    assert.doesNotMatch(notice, /unlimited/i);
    assert.doesNotMatch(notice, /clinical advice as/i);
  });

  it('keeps the Standard/Pro picker honest to /api/chat/stream', async () => {
    const source = await readSource(componentSources.chatInputActions);
    const usage = await readSource('frontend/src/components/settings/tabs/UsageSettingsTab.tsx');

    assert.match(source, /role="listbox"/);
    assert.match(source, /role="option"/);
    assert.match(source, /aria-haspopup="listbox"/);
    assert.match(source, /disabled=\{isGenerating\}/);
    assert.match(source, /1 credit per reply/);
    assert.match(source, /2 credits per reply/);
    assert.match(source, /Same model/);
    assert.match(source, /chat-mode-menu/);
    assert.match(source, /createPortal/);
    assert.doesNotMatch(source, /clinical/i);
    assert.doesNotMatch(source, /2x compute/i);
    assert.doesNotMatch(source, /lighter listening/i);
    assert.doesNotMatch(source, /#4140FD/);
    assert.doesNotMatch(source, /text-\[11px\]/);

    assert.match(usage, /Standard costs 1, Pro costs 2/);
    assert.match(usage, /same reply model/);
    assert.doesNotMatch(usage, /clinical/i);
  });

  it('keeps the chat canvas streaming and retry contracts explicit', async () => {
    const source = await readSource(componentSources.chatCanvas);
    assert.match(source, /role="log"/);
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /ChatCanvasMessage/);
    assert.match(source, /onRegenerate=\{handleRegenerate\}/);
    assert.match(source, /onMemory/);
    assert.match(source, /captureMemoryReceipt/);
    assert.match(source, /onReviewMemory/);
    assert.match(source, /handleEditUser/);
    assert.match(source, /handleSaveEdit/);
    assert.match(source, /handleCancelEdit/);
    assert.match(source, /setEditingUserId/);
    assert.match(source, /onSaveEdit/);
    assert.doesNotMatch(source, /setComposerDraft/);
    assert.match(source, /aria-label="Jump to latest"/);
    assert.match(source, /chat-jump-latest/);
    assert.doesNotMatch(source, /chat-canvas--fade-top/);
    assert.doesNotMatch(source, /chat-canvas--fade-bottom/);
    assert.doesNotMatch(source, /chat-thread-fade/);
    assert.match(source, /scrollTo/);
    assert.match(source, /onMouseDown/);
    assert.doesNotMatch(source, /scrollIntoView/);
    assert.doesNotMatch(source, /shadow-card/);
  });

  it('keeps chat thread chrome token-based and quieter than a chatbot kit', async () => {
    const source = await readSource(componentSources.chatCanvasMessage);
    assert.match(source, /dir="auto"/);
    assert.match(source, /chat-user-bubble/);
    assert.match(source, /bg-surface-subtle/);
    assert.match(source, /w-fit max-w-\[min\(78%,36rem\)\]/);
    assert.match(source, /chat-prose/);
    assert.doesNotMatch(source, /break-all/);
    assert.doesNotMatch(source, /text-justify/);
    assert.match(source, /chat-caret/);
    assert.match(source, /msg-actions/);
    assert.match(source, /data-active/);
    assert.match(source, /chat-turn--user/);
    assert.match(source, /chat-turn--assistant/);
    assert.match(source, /animateEnter/);
    assert.match(source, /ChatMemoryReceipt/);
    assert.match(source, /ChatVoiceReceipt/);
    assert.match(source, /chat-turn--call-ended/);
    assert.match(source, /voice_used_s/);
    assert.match(source, /heldReceipt/);
    assert.match(source, /receiptActive/);
    assert.match(source, /ChatUserMessageEdit/);
    assert.match(source, /isEditing/);
    assert.match(source, /lockBubbleForMorph/);
    assert.match(source, /chat-user-shell--morph/);
    assert.match(source, /msg-actions--away/);
    assert.match(source, /aria-label="Copy response"/);
    assert.match(source, /aria-label="Copy message"/);
    assert.match(source, /Edit and resend this message/);
    assert.match(source, /later replies in this thread will be removed/);
    assert.match(source, /Read aloud/);
    assert.match(source, /Regenerate response/);
    assert.match(source, /Retry response/);
    assert.doesNotMatch(source, />\s*Retry\s*</);
    assert.doesNotMatch(source, /Thinking/);
    assert.doesNotMatch(source, /animate-pulse/);
    assert.doesNotMatch(source, /#4140FD/);
    assert.doesNotMatch(source, /text-\[11px\]/);
    assert.doesNotMatch(source, /text-emerald-500/);
    assert.doesNotMatch(source, /text-rose-500/);
    assert.doesNotMatch(source, /bg-brand-primary[^\-/]/);

    const style = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');
    assert.match(style, /@media \(hover: hover\) and \(pointer: fine\)/);
    assert.match(style, /\.chat-user-shell:not\(:hover\):not\(:focus-within\) \.msg-actions/);
    assert.doesNotMatch(style, /\.chat-turn--user:not\(:hover\):not\(:focus-within\) \.msg-actions/);
    assert.match(style, /\.chat-jump-latest/);
    assert.match(style, /\.chat-jump-latest\.is-leaving/);
    assert.doesNotMatch(style, /\.chat-canvas--fade-top/);
    assert.doesNotMatch(style, /\.chat-canvas--fade-bottom/);
    assert.doesNotMatch(style, /\.chat-thread-fade/);
    assert.match(style, /\.chat-composer__row--grown/);
    assert.match(style, /\.chat-composer__idle-actions--expand/);
    assert.match(style, /\.chat-composer--expanded/);
    assert.doesNotMatch(style, /\.chat-composer__body--fade-top/);
    assert.doesNotMatch(style, /\.chat-composer__body--fade-bottom/);
    assert.doesNotMatch(style, /--overflow-pad:/);
    assert.doesNotMatch(style, /--overflow-shadow:/);
    assert.match(style, /\.memory-receipt--out/);
    assert.match(style, /--memory-receipt-ms:\s*180ms/);
    assert.match(style, /@keyframes memoryReceiptOut/);
    assert.match(style, /\.memory-search/);
    assert.match(style, /\.memory-atom/);
    assert.match(style, /\.chat-prose/);
    assert.match(style, /\.chat-user-bubble/);
    assert.match(style, /\.chat-turn--pending-replace/);
    assert.match(style, /\.chat-user-edit__field/);
    assert.match(style, /\.chat-user-bubble--morph/);
    assert.match(style, /--edit-morph-ms:\s*240ms/);
    assert.match(style, /chatEditChromeIn/);
    assert.match(style, /\.msg-actions--away/);
    assert.doesNotMatch(style, /--mindpal-user-bubble-bg/);
    assert.doesNotMatch(style, /\.chat-user-bubble\s*\{[^}]*!important/);
    assert.match(style, /overflow-wrap:\s*anywhere/);
    assert.match(style, /word-break:\s*normal/);
    assert.match(style, /line-break:\s*auto/);
    assert.match(style, /unicode-bidi:\s*plaintext/);
    assert.match(style, /\.chat-stage/);
    assert.match(style, /\.chat-composer-dock/);
    assert.match(style, /\.chat-composer--thinking/);
    assert.match(style, /--composer-radius:\s*1\.9375rem/);
    assert.match(style, /--composer-morph-ms:\s*240ms/);
    assert.match(style, /--composer-fade-ms:\s*160ms/);
    assert.match(style, /\.chat-composer--dictating \.chat-composer__dictate/);
    assert.match(style, /grid-template-rows:\s*0fr/);
    assert.match(style, /grid-template-rows:\s*1fr/);
    assert.doesNotMatch(style, /\.chat-composer--tall/);
    assert.doesNotMatch(style, /\.chat-composer\s*\{[^}]*border-radius:\s*9999px/);
    assert.match(style, /border-radius:\s*inherit/);
    assert.match(style, /composerThinkSweep/);
    assert.match(style, /composerThinkIn/);
    assert.match(style, /composerThinkOut/);
    assert.match(style, /--composer-think-from/);
    assert.match(style, /@property --composer-think-angle/);
    assert.match(style, /@property --composer-think-fade/);
    assert.match(
      style,
      /\.chat-composer--thinking::before,\s*\.chat-composer--thinking::after,[\s\S]*?html\.dark \.chat-composer--thinking::after \{\s*animation: none;/,
    );
    assert.match(style, /\.chat-mode-menu/);
    assert.match(style, /\.chat-msg-enter/);
    assert.match(style, /\.chat-thread-enter/);
    assert.match(style, /@keyframes chatThreadIn/);
    assert.match(style, /@keyframes chatMsgIn \{\s*from \{ opacity: 0; \}/);
    assert.match(style, /\.mood-chip/);
    assert.match(style, /moodChipIn/);
    assert.match(style, /\.composer-notice/);
    assert.match(style, /\.icon-hit/);
    assert.match(style, /\.icon-hit\s*\{[^}]*border-radius:\s*9999px/);
    assert.match(style, /prefers-reduced-motion/);
    assert.doesNotMatch(
      style,
      /button,\s*input,\s*select,\s*textarea,\s*\[role="button"\]\s*\{\s*min-height:\s*44px/
    );
  });

  it('keeps live-call end as a divider with expandable recap, not a LIVE VOICE card', async () => {
    const receipt = await readSource(componentSources.chatVoiceReceipt);
    const overlay = await readSource('frontend/src/components/voice/VoiceOverlay.tsx');
    const persistence = await readSource('frontend/src/hooks/chat/useChatSessionPersistence.ts');
    const style = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');

    assert.match(receipt, /Call ended/);
    assert.match(receipt, /chat-call-ended__toggle/);
    assert.match(receipt, /aria-expanded/);
    assert.match(receipt, /formatCallDuration/);
    assert.match(receipt, /chat-call-ended__body/);
    assert.match(receipt, /copied \? 'Copied' : 'Copy'/);
    assert.match(receipt, /aria-label=\{copied \? 'Copied recap' : 'Copy recap'\}/);
    assert.match(receipt, /<Copy /);
    assert.doesNotMatch(receipt, /Live voice/);
    assert.doesNotMatch(receipt, /uppercase tracking-wide/);
    assert.doesNotMatch(receipt, /chat-prose/);
    assert.match(style, /\.chat-call-ended__toggle/);
    assert.match(style, /\.chat-call-ended__rule--start/);
    assert.match(style, /\.chat-call-ended__rule--end/);
    assert.match(style, /linear-gradient\([\s\S]*?to right[\s\S]*?transparent/);
    assert.match(style, /linear-gradient\([\s\S]*?to left[\s\S]*?transparent/);
    assert.match(style, /\.chat-call-ended__body/);
    assert.match(style, /\.chat-call-ended__copy/);
    assert.match(style, /text-align:\s*center/);
    assert.match(receipt, /chat-call-ended__collapse/);
    assert.match(receipt, /open && 'is-open'/);
    assert.match(style, /--call-ended-ms:\s*220ms/);
    assert.match(style, /grid-template-rows:\s*0fr/);
    assert.match(style, /grid-template-rows:\s*1fr/);
    assert.match(style, /\.chat-call-ended__collapse\.is-open/);
    assert.match(overlay, /ensureActiveSessionId/);
    assert.match(overlay, /boundChatSessionIdRef/);
    assert.match(overlay, /setThreadNote/);
    assert.match(overlay, /threadContinuation/);
    assert.match(overlay, /chat_session_id: chatSessionId/);
    assert.doesNotMatch(persistence, /setActiveSessionId\(null\)/);
    assert.match(persistence, /ensureActiveSessionId/);
  });

  it('keeps a single bottom composer outside the empty canvas', async () => {
    const panels = await readSource('frontend/src/components/app/AppPanels.tsx');
    const empty = await readSource('frontend/src/components/chat/canvas/ChatCanvasEmptyState.tsx');
    const canvas = await readSource(componentSources.chatCanvas);

    assert.equal((panels.match(/<ChatInput /g) || []).length, 1);
    assert.match(panels, /chat-stage/);
    assert.match(panels, /fill: 'none'/);
    assert.doesNotMatch(panels, /fill: 'both'/);
    assert.doesNotMatch(panels, /animation\.cancel\(\)/);
    assert.doesNotMatch(empty, /ChatInput/);
    assert.doesNotMatch(canvas, /<ChatInput/);
    assert.match(canvas, /chat-thread-enter/);
    assert.match(canvas, /animateEnter/);
    assert.match(canvas, /enteringIds/);
    assert.match(canvas, /useLayoutEffect/);
    assert.match(canvas, /scrollCanvasToBottom\(false\)/);
    assert.doesNotMatch(canvas, /scrollCanvasToBottom\(!isGenerating\)/);
    assert.match(empty, /mood-chip/);
    assert.match(empty, /chat-empty--reveal/);
    assert.match(empty, /SkeletonMoodChips/);
    assert.doesNotMatch(empty, /relative z-10/);
    assert.match(canvas, /emptyLoading/);
    assert.doesNotMatch(canvas, /revealEmpty/);
  });

  it('keeps the memory receipt honest and token-based', async () => {
    const receipt = await readSource(componentSources.chatMemoryReceipt);
    const chatApi = await readSource(componentSources.chatApi);
    assert.match(receipt, /Saved to memory/);
    assert.match(receipt, /aria-label="Review memory"/);
    assert.match(receipt, /role="status"/);
    assert.match(receipt, /aria-atomic="true"/);
    assert.match(receipt, /memory-receipt--out/);
    assert.match(receipt, /HOLD_MS = 7000/);
    assert.match(receipt, /FADE_MS = 180/);
    assert.match(receipt, /useOverlayPresence\(\s*open && active,\s*FADE_MS/);
    assert.doesNotMatch(receipt, /overlay-panel/);
    assert.doesNotMatch(receipt, /overlay-backdrop/);
    assert.doesNotMatch(receipt, /remembered everything/i);
    assert.doesNotMatch(receipt, /#4140FD/);
    assert.doesNotMatch(receipt, /text-\[11px\]/);
    assert.doesNotMatch(receipt, /text-brand-primary/);
    assert.doesNotMatch(receipt, /rounded-2xl/);
    assert.match(chatApi, /parseMemoryReceipt/);
    assert.match(chatApi, /onMemory/);
    assert.doesNotMatch(chatApi, /user_id_hash/);
    assert.doesNotMatch(chatApi, /GUEST_DEVICE_ID/);
    assert.doesNotMatch(chatApi, /usr_anon_default/);
  });

  it('keeps the memory inspector honest and jumps Review to saved ids', async () => {
    const inspector = await readSource(componentSources.memoryInspector);
    const header = await readSource(componentSources.memoryInspectorHeader);
    const canvas = await readSource(componentSources.chatCanvas);
    const memoryApi = await readSource(componentSources.memoryApi);

    assert.match(inspector, /Nothing stored yet/);
    assert.match(inspector, /Saved facts appear after a turn/);
    assert.match(inspector, /No saved facts match/);
    assert.match(inspector, /Search saved facts/);
    assert.match(inspector, /Pencil/);
    assert.match(inspector, /patchMemoryGraphItem/);
    assert.match(inspector, /memory-search/);
    assert.match(inspector, /memory-atom/);
    assert.match(inspector, /returnToSettings/);
    assert.match(inspector, /layer=\{70\}/);
    assert.match(inspector, /highlightAtomIds/);
    assert.match(inspector, /data-atom-id/);
    assert.match(inspector, /scrollIntoView/);
    assert.doesNotMatch(inspector, /ring-2 ring-brand-primary/);
    assert.doesNotMatch(inspector, /personal memory profile/i);
    assert.doesNotMatch(inspector, /therapeutic/i);
    assert.doesNotMatch(inspector, /Resynthesize/);
    assert.doesNotMatch(inspector, /user_id_hash/);
    assert.doesNotMatch(inspector, /#4140FD/);
    assert.doesNotMatch(inspector, /text-\[11px\]/);
    assert.doesNotMatch(header, /therapeutic/i);
    assert.doesNotMatch(header, /durable personal insights/i);
    assert.match(canvas, /setIsOpen\(true, 'atoms', ids\)/);
    assert.match(memoryApi, /honestMemorySummary/);
    assert.match(memoryApi, /loadGuestGraph/);
    assert.match(memoryApi, /mergeGuestGraphIntoAccount/);
    assert.match(memoryApi, /patchMemoryGraphItem/);
    assert.match(memoryApi, /updateGuestAtom/);
    assert.doesNotMatch(memoryApi, /\.\.\.atom/);
    assert.doesNotMatch(memoryApi, /usr_anon_default/);
  });

  it('keeps the auth modal dialog and focus contracts explicit', async () => {
    const source = await readSource(componentSources.authModal);
    assert.match(source, /<Modal/);
    assert.match(source, /ModalHeader/);
    assert.match(source, /AuthChoiceView/);
    assert.match(source, /AuthEmailView/);
    assert.match(source, /Sign in to MindPal/);
    assert.doesNotMatch(source, /Back up your MindPal/);
    assert.doesNotMatch(source, /overlayShellClass/);
  });

  it('keeps the settings modal tabs and mobile selector contract explicit', async () => {
    const source = await readSource(componentSources.settingsModal);
    for (const tab of ['general', 'mental-health', 'features', 'voice', 'analytics', 'personalization', 'usage', 'data', 'security', 'account']) {
      assert.match(source, new RegExp(`id: '${tab}'`));
    }
    assert.match(source, /<Modal/);
    assert.match(source, /SettingsMobileNav/);
    assert.match(source, /aria-label="Select settings category"|categoryLabel="Select settings category"/);
    assert.doesNotMatch(source, /<select/);
    assert.match(source, /returnToSettings: true/);
    assert.match(source, /inert=\{memoryOpen\}/);
    assert.doesNotMatch(source, /setIsOpen\(false\);\s*useMemoryStore/);
    assert.match(source, /AnalyticsSettingsTab/);
    assert.match(source, /UsageSettingsTab/);
  });

  it('keeps the history modal search, focus, and cloud recovery contract explicit', async () => {
    const source = await readSource(componentSources.historyModal);
    assert.match(source, /<Modal/);
    assert.match(source, /ModalToolbar/);
    assert.match(source, /Search/);
    assert.doesNotMatch(source, /Press Enter to open/);
    assert.match(source, /Cloud history unavailable/);
    assert.match(source, /Retry sync/);
    assert.doesNotMatch(source, /maxHeight: 'calc\(100dvh - 100px\)'/);
    const sessionItem = await readSource('frontend/src/components/chat/history/ChatHistorySessionItem.tsx');
    const historyGroups = await readSource('frontend/src/components/chat/history/ChatHistoryGroups.tsx');
    const historyStyle = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');
    assert.match(sessionItem, /MessageSquare/);
    assert.match(sessionItem, /Rename conversation/);
    assert.match(sessionItem, /history-rename/);
    assert.match(sessionItem, /history-session-item/);
    assert.match(sessionItem, /history-session-item__open/);
    assert.match(sessionItem, /Open conversation/);
    assert.match(sessionItem, /Editing conversation title/);
    assert.match(sessionItem, /aria-pressed=\{isEditing\}/);
    assert.match(sessionItem, /data-overlay-escape="ignore"/);
    assert.doesNotMatch(sessionItem, /role="button"/);
    assert.doesNotMatch(sessionItem, /shadow-card|bg-brand-primary/);
    assert.match(historyGroups, /history-session-list/);
    assert.match(historyStyle, /\.history-rename \{[^}]*height:\s*1\.25rem/);
    assert.match(historyStyle, /inset 0 -1px 0 var\(--brand-primary\)/);
    assert.match(historyStyle, /\.history-session-item \{[^}]*border:\s*1px solid transparent/);
    assert.match(historyStyle, /\.history-session-list \{[^}]*gap:\s*0\.375rem/);
    assert.match(historyStyle, /\.history-session-item__open \{[^}]*inset:\s*0/);
    assert.match(historyStyle, /\.history-session-item > \.history-session-item__actions \{[^}]*pointer-events:\s*auto/);
    assert.match(historyStyle, /\.history-session-item \.history-row-action,[\s\S]*?pointer-events:\s*auto/);
    assert.match(historyStyle, /\.history-session-item__title[\s\S]{0,80}pointer-events:\s*none/);
    assert.doesNotMatch(historyStyle, /\.history-session-item[^{]*\{[^}]*shadow-card/);
    const trap = await readSource('frontend/src/hooks/ui/useFocusTrap.ts');
    assert.match(trap, /onCloseRef/);
    assert.match(trap, /pausedRef/);
    assert.match(trap, /data-overlay-escape="ignore"/);
    assert.match(trap, /inFloatingMenu/);
    assert.match(trap, /\[isOpen\]/);
  });

  it('keeps Settings responsive navigation visible at the correct breakpoint', async () => {
    const sidebar = await readSource(componentSources.settingsSidebar);
    const style = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');

    assert.match(sidebar, /hidden sm:flex/);
    assert.match(sidebar, /settingsNavItemClass/);
    assert.doesNotMatch(sidebar, /bg-brand-primary text-white/);
    assert.doesNotMatch(style, /^\.hidden\s*\{[^}]*display:\s*none\s*!important/m);
  });

  it('keeps settings copy honest and token-based', async () => {
    const settingsFiles = [
      'frontend/src/components/settings/SettingsModal.tsx',
      'frontend/src/components/settings/SettingsSidebar.tsx',
      'frontend/src/components/settings/SettingsMobileNav.tsx',
      'frontend/src/components/settings/SettingsPrimitives.tsx',
      'frontend/src/components/settings/tabs/UsageSettingsTab.tsx',
      'frontend/src/components/settings/tabs/SecuritySettingsTab.tsx',
      'frontend/src/components/settings/tabs/VoiceSettingsTab.tsx',
      'frontend/src/components/settings/tabs/MentalHealthSettingsTab.tsx',
      'frontend/src/components/settings/tabs/AccountSettingsTab.tsx',
      'frontend/src/components/settings/tabs/AnalyticsSettingsTab.tsx',
      'frontend/src/components/settings/tabs/FeaturesSettingsTab.tsx',
      'frontend/src/components/settings/tabs/PersonalizationSettingsTab.tsx',
      'frontend/src/components/settings/tabs/GeneralSettingsTab.tsx',
      'frontend/src/components/settings/tabs/DataControlsSettingsTab.tsx',
      'frontend/src/components/settings/wellness/WellnessOverview.tsx',
    ];
    const joined = (await Promise.all(settingsFiles.map(readSource))).join('\n');

    assert.doesNotMatch(joined, /#4140FD/);
    assert.doesNotMatch(joined, /Preview \/ Unlimited/);
    assert.doesNotMatch(joined, /Gemini Live/);
    assert.doesNotMatch(joined, /UID:/);
    assert.doesNotMatch(joined, /never persisted in localStorage/);
    assert.doesNotMatch(joined, /text-\[11px\]/);
    assert.doesNotMatch(joined, /Firestore/i);
    assert.doesNotMatch(joined, /\bFirebase\b/);
    assert.doesNotMatch(joined, /bg-brand-primary text-white/);
    assert.doesNotMatch(joined, /bg-brand-primary hover:bg-brand-hover text-white/);
    assert.match(joined, /\/api\/chat\/stream/);
    assert.match(joined, /window\.confirm/);
    assert.match(joined, /not a diagnosis/);
    assert.match(joined, /\/api\/user\/wellness-timeline/);
    assert.match(joined, /No usage yet/);
    assert.match(joined, /MindPal.s servers/);
    assert.match(joined, /settings-meter/);
    assert.match(joined, /SettingsSelect/);
    assert.match(joined, /role="listbox"/);
    assert.match(joined, /settings-select-menu/);
    assert.match(joined, /Download my data/);
    assert.match(joined, /exportUserData/);
    assert.match(joined, /deleteUserData/);
    assert.doesNotMatch(joined, /<select/);
    assert.doesNotMatch(joined, /SettingsCard/);
    assert.doesNotMatch(joined, /rounded-2xl border border-edge-subtle bg-surface-subtle/);
    assert.doesNotMatch(joined, /Export JSON/);
  });

  it('keeps the shell header thin with overflow actions still reachable', async () => {
    const header = await readSource(componentSources.header);
    const envTag = await readSource(componentSources.envTag);
    const app = await readSource(componentSources.appShell);

    assert.match(header, /aria-label="New chat"/);
    assert.match(header, /aria-label="Open chat history"/);
    assert.match(header, /aria-label="Toggle theme"/);
    assert.match(header, /aria-label="View daily streak progress"/);
    assert.match(header, /aria-label="More actions"/);
    assert.match(header, /hidden sm:inline-flex/);
    assert.match(header, /sm:hidden/);
    // New chat is confirmed in-page (a blocking window.confirm is gone for good).
    assert.doesNotMatch(header, /window\.confirm\(\s*['"`]/);
    assert.match(header, /Start new conversation\?/);
    assert.match(header, /setActiveSessionId\(null\)/);
    assert.match(header, /<p className="select-none/);
    assert.doesNotMatch(header, /onClick=\{handleNewChat\}[\s\S]*MindPal/);
    assert.match(header, /focus-visible:ring-2/);
    assert.match(header, /duration-150/);
    assert.match(header, /TabBar/);
    assert.doesNotMatch(header, /#4140FD/);
    assert.doesNotMatch(header, /text-\[11px\]/);

    assert.match(envTag, /aria-label="This device"/);
    assert.match(envTag, /aria-label="Account"/);
    assert.match(envTag, /useIsSignedIn/);
    assert.doesNotMatch(envTag, /<span>Local<\/span>/);
    assert.doesNotMatch(envTag, /bg-surface-subtle/);
    assert.doesNotMatch(envTag, /Cloud Synced/);
    assert.doesNotMatch(envTag, /live sync status/);

    assert.match(app, /showPresenceTab=\{showPresenceTab\}/);
    assert.doesNotMatch(app, /pt-16/);
    assert.doesNotMatch(app, /<TabBar /);
    assert.doesNotMatch(app, /GlobalLoader/);
    assert.match(app, /useAppBootstrap\(\);/);
  });

  it('keeps the changelog modal spacious and honest', async () => {
    const modal = await readSource('frontend/src/components/changelog/ChangelogModal.tsx');
    const hero = await readSource('frontend/src/components/changelog/ChangelogHero.tsx');
    const highlights = await readSource('frontend/src/components/changelog/ChangelogHighlights.tsx');
    const contract = await readSource('contracts/changelog.json');

    assert.match(modal, /max-w-lg/);
    assert.match(modal, /px-6/);
    assert.match(modal, /space-y-5/);
    assert.match(modal, /h-12/);
    assert.doesNotMatch(modal, /max-w-\[360px\]/);
    assert.doesNotMatch(modal, /text-\[11px\]/);
    assert.doesNotMatch(modal, /clinical/i);
    assert.doesNotMatch(hero, /text-\[10px\]/);
    assert.match(hero, /h-56/);
    assert.match(hero, /text-2xl/);
    assert.match(highlights, /py-3.5/);
    assert.match(highlights, /text-sm/);
    assert.match(highlights, /changelog-check/);
    assert.doesNotMatch(highlights, /text-\[11px\]/);
    assert.doesNotMatch(highlights, /border-brand-primary/);
    assert.match(contract, /A calmer chat shell/);
    assert.match(contract, /Not a live voice call/);
    assert.match(contract, /Live voice preview/);
    assert.match(contract, /30 minutes per day/);
    assert.doesNotMatch(contract, /clinical/i);
    assert.doesNotMatch(contract, /unlimited/i);
    assert.doesNotMatch(contract, /Presence Preview/i);
  });

  it('keeps the streak card honest and token-based', async () => {
    const modal = await readSource('frontend/src/components/streak/StreakModal.tsx');
    const store = await readSource('frontend/src/store/streak.ts');
    const copy = await readSource('frontend/src/utils/streak/streak.ts');
    const header = await readSource(componentSources.header);
    const style = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');

    assert.match(modal, /Showing up/);
    assert.match(modal, /streak-week/);
    assert.match(modal, /Close progress view/);
    assert.match(modal, /<Modal/);
    assert.match(modal, /ModalHeader/);
    assert.doesNotMatch(modal, /Your Journey/);
    assert.doesNotMatch(modal, /emotional resilience/i);
    assert.doesNotMatch(modal, /animate-pulse/);
    assert.doesNotMatch(modal, /orange-/);
    assert.doesNotMatch(modal, /#4140FD/);
    assert.doesNotMatch(modal, /shadow-\[0_0_/);

    assert.match(store, /getUserInsights/);
    assert.match(store, /restoreDeviceStreak/);
    assert.match(copy, /Counted on this device until you sign in/);
    assert.match(copy, /One message is enough/);
    assert.doesNotMatch(copy, /resilience/i);

    assert.match(header, /Days you showed up/);
    assert.doesNotMatch(header, /orange-/);

    assert.match(style, /\.streak-week/);
    assert.match(style, /\.streak-day__mark--done/);
    assert.doesNotMatch(style, /249,\s*115,\s*22/);
  });

  it('lets overlays finish their close transition before unmounting', async () => {
    const dialogs = [
      'frontend/src/components/auth/AuthModal.tsx',
      'frontend/src/components/settings/SettingsModal.tsx',
      'frontend/src/components/memory/MemoryInspector.tsx',
      'frontend/src/components/changelog/ChangelogModal.tsx',
      'frontend/src/components/streak/StreakModal.tsx',
      'frontend/src/components/chat/history/ChatHistoryModal.tsx',
    ];
    const overlayUtil = await readSource('frontend/src/utils/ui/overlay.ts');
    const presence = await readSource('frontend/src/hooks/ui/useOverlayPresence.ts');
    const modal = await readSource('frontend/src/components/ui/Modal.tsx');
    const style = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');

    assert.match(presence, /OVERLAY_EXIT_MS = 100/);
    assert.match(presence, /setMounted\(false\)/);
    assert.match(overlayUtil, /overlay-panel/);
    assert.match(overlayUtil, /is-open/);
    assert.match(style, /overlayPanelIn/);
    assert.match(style, /\.mp-modal__panel/);
    assert.match(style, /\.mp-modal__kicker/);
    assert.match(style, /\.mp-modal__close/);
    assert.match(modal, /useOverlayPresence/);
    assert.match(modal, /useFocusTrap/);
    assert.match(modal, /paused: inert/);
    assert.match(modal, /export function ModalHeader/);

    for (const path of dialogs) {
      const source = await readSource(path);
      assert.match(source, /<Modal/, path);
      assert.doesNotMatch(source, /useOverlayPresence/, path);
      assert.doesNotMatch(source, /animate-fade-in-fast/, path);
      assert.doesNotMatch(source, /animate-scale-in/, path);
    }

    const popovers = [componentSources.header, componentSources.chatInputActions];
    for (const path of popovers) {
      const source = await readSource(path);
      assert.match(source, /useOverlayPresence/, path);
    }

    assert.doesNotMatch(await readSource(componentSources.authModal), /if \(!isAuthModalOpen\) return null/);
    assert.doesNotMatch(await readSource(componentSources.settingsModal), /if \(!isOpen\) return null/);
    assert.doesNotMatch(await readSource(componentSources.memoryInspector), /if \(!isOpen\) return null/);
  });

  it('keeps toasts token-based and stacked for phone vs desktop', async () => {
    const toast = await readSource('frontend/src/components/ui/Toast.tsx');
    const style = await readFile(new URL('../../frontend/css/style.css', import.meta.url), 'utf8');

    assert.match(toast, /toast-region/);
    assert.match(toast, /toast-card/);
    assert.match(toast, /Dismiss notification/);
    assert.doesNotMatch(toast, /text-\[13px\]/);
    assert.doesNotMatch(toast, /top-5 right-5/);
    assert.doesNotMatch(toast, /#4140FD/);
    assert.match(style, /\.toast-region/);
    assert.match(style, /toastInMobile/);
    assert.match(style, /toastInDesktop/);
    assert.match(style, /safe-area-inset-bottom/);
    assert.match(toast, /toast-card--out/);
    assert.match(style, /toastOutMobile/);
    assert.match(style, /toastOutDesktop/);
  });

});
