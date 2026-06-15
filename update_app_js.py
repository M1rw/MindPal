import sys
import re

with open('frontend/js/app.js', encoding='utf-8') as f:
    content = f.read()

# For submitForm, lines 1640 to 1699 roughly.
# We will use regex or find to replace the blocks.

# Define the old block for submitForm
old_submit_start = "    const response = await sendChatMessage({"
old_submit_end = "notifyFromSetting(\"responseComplete\", \"MindPal response ready\", \"MindPal finished the response.\");"

# Extract the old block
start_idx = content.find(old_submit_start)
end_idx = content.find(old_submit_end, start_idx) + len(old_submit_end)

if start_idx != -1 and end_idx != -1:
    old_block = content[start_idx:end_idx]
    
    new_block = """    const chatHistory = document.getElementById("chat-history");
    const msgDiv = document.createElement("div");
    msgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    const contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentContainer.appendChild(contentBox);
    msgDiv.appendChild(contentContainer);
    if (chatHistory) chatHistory.appendChild(msgDiv);
    
    if (smoothScroll) scrollChatToBottom("smooth"); // We need to define smoothScroll here? Actually just use true
    
    let streamResponseStr = "";
    let backendMetaFinal = null;

    removeStatusIndicator(statusId);

    // Send clean message only. Memory/context managed by backend via system prompt.
    await sendChatMessageStream({
      message: outboundMessage,
      history: state.chatMemory,
      locale: resolveLocale(),
      mode,
      token,
      profileContext: {
        ...(currentCloudProfileContext || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (text) => {
        streamResponseStr += text;
        const parsed = processStructuredResponse(streamResponseStr);
        contentBox.innerHTML = parsed.finalHtml;
        scrollChatToBottom("smooth");
      },
      onMetadata: (meta) => {
        backendMetaFinal = meta;
      }
    });

    const reply = streamResponseStr.trim();
    if (!reply) {
      throw new Error("Backend returned empty reply.");
    }

    if (isSafetyLock(backendMetaFinal)) {
      isSessionLocked = true;
      voiceController?.setLocked(true);
    }

    const assistantMessageRecord = addMessage("MindPal", reply, {
      requestId: backendMetaFinal?.request_id || null,
      providerUsed: backendMetaFinal?.provider_used || null,
      safety: backendMetaFinal?.safety || null,
      ragUsed: backendMetaFinal?.rag_used || [],
      memoryUpdated: Boolean(backendMetaFinal?.memory_updated),
    });

    scheduleCloudMessageSync(assistantMessageRecord);

    if (backendMetaFinal?.memory_summary) {
      memoryContext = saveMemoryContext(
        mergeMemoryContexts(memoryContext, memoryFromBackendSummary(backendMetaFinal.memory_summary)),
      );
    }

    if (backendMetaFinal?.memory_graph_snapshot && backendMetaFinal?.memory_graph_full_snapshot) {
      memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(backendMetaFinal.memory_graph_snapshot));
    } else if (backendMetaFinal?.memory_graph_delta) {
      memoryGraphContext = saveMemoryGraphContext(
        mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(backendMetaFinal.memory_graph_delta)),
      );
    }

    if (backendMetaFinal?.memory_summary || backendMetaFinal?.memory_graph_snapshot || backendMetaFinal?.memory_graph_delta) {
      renderMemoryInspector();
    }

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    const isCrisis = isCrisisReply(reply, safetyLevel);
    if (isCrisis) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    } else {
      contentContainer.appendChild(buildMessageActions(reply));
    }

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(msgDiv);
    refreshIcons();

    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the response.");"""
    
    content = content[:start_idx] + new_block + content[end_idx:]


# For regenerateMessage
old_regen_start = "    const response = await sendChatMessage({"
old_regen_end = "notifyFromSetting(\"responseComplete\", \"MindPal response ready\", \"MindPal finished the regenerated response.\");"

start_idx = content.find(old_regen_start, end_idx)
end_idx = content.find(old_regen_end, start_idx) + len(old_regen_end)

if start_idx != -1 and end_idx != -1:
    new_block_regen = """    const chatHistory = document.getElementById("chat-history");
    const msgDiv = document.createElement("div");
    msgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    const contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentContainer.appendChild(contentBox);
    msgDiv.appendChild(contentContainer);
    if (chatHistory) chatHistory.appendChild(msgDiv);

    let streamResponseStr = "";
    let backendMetaFinal = null;

    removeStatusIndicator(statusId);

    await sendChatMessageStream({
      message: userMessage,
      history: messages.slice(0, userIndex),
      locale: resolveLocale(),
      mode,
      token,
      profileContext: {
        ...(currentCloudProfileContext || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (text) => {
        streamResponseStr += text;
        const parsed = processStructuredResponse(streamResponseStr);
        contentBox.innerHTML = parsed.finalHtml;
        scrollChatToBottom("smooth");
      },
      onMetadata: (meta) => {
        backendMetaFinal = meta;
      }
    });

    const reply = streamResponseStr.trim();
    if (!reply) {
      throw new Error("Backend returned empty reply.");
    }

    if (isSafetyLock(backendMetaFinal)) {
      isSessionLocked = true;
      voiceController?.setLocked(true);
    }

    const regeneratedRecord = addMessage("MindPal", reply, {
      requestId: backendMetaFinal?.request_id || null,
      providerUsed: backendMetaFinal?.provider_used || null,
      safety: backendMetaFinal?.safety || null,
      ragUsed: backendMetaFinal?.rag_used || [],
      memoryUpdated: Boolean(backendMetaFinal?.memory_updated),
      regenerated: true,
    });

    scheduleCloudMessageSync(regeneratedRecord);

    if (backendMetaFinal?.memory_summary) {
      memoryContext = saveMemoryContext(
        mergeMemoryContexts(memoryContext, memoryFromBackendSummary(backendMetaFinal.memory_summary)),
      );
    }

    if (backendMetaFinal?.memory_graph_snapshot && backendMetaFinal?.memory_graph_full_snapshot) {
      memoryGraphContext = saveMemoryGraphContext(memoryGraphFromBackend(backendMetaFinal.memory_graph_snapshot));
    } else if (backendMetaFinal?.memory_graph_delta) {
      memoryGraphContext = saveMemoryGraphContext(
        mergeMemoryGraphs(memoryGraphContext, memoryGraphFromBackend(backendMetaFinal.memory_graph_delta)),
      );
    }

    if (backendMetaFinal?.memory_summary || backendMetaFinal?.memory_graph_snapshot || backendMetaFinal?.memory_graph_delta) {
      renderMemoryInspector();
    }

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    const isCrisis = isCrisisReply(reply, safetyLevel);
    if (isCrisis) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    } else {
      contentContainer.appendChild(buildMessageActions(reply));
    }

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(msgDiv);
    refreshIcons();

    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the regenerated response.");"""
    
    content = content[:start_idx] + new_block_regen + content[end_idx:]


with open('frontend/js/app.js', 'w', encoding='utf-8') as f:
    f.write(content)
