/** English-first Discord bot dashboard for pi-web-ui. */

import { createHostRequestBridge } from "./host-bridge.mjs";

export default {
	async mount(element, context) {
		const hostBridge = createHostRequestBridge(context);
		const sendHost = (type, payload = {}) => hostBridge.send(type, payload);

		element.innerHTML = `
			<div class="discord-root" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); font-size: 13px;">
				<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg-elev);">
					<div style="display: flex; align-items: center; gap: 8px;">
						<span style="font-size: 18px;">🎮</span>
						<span style="font-weight: 600; font-size: 14px;">Discord Bot Dashboard</span>
						<span class="discord-status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);">Checking…</span>
					</div>
					<button class="discord-btn-config" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">⚙️ Configure</button>
				</div>

				<div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px;">
							<div style="font-weight: 600; font-size: 14px;">🤖 Discord Gateway connection</div>
							<button class="discord-btn-toggle-bot" style="padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; font-size: 12px;">Toggle bot service</button>
						</div>
						<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;">
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">Gateway state</div>
								<div class="discord-metric-state" style="font-size: 14px; font-weight: 600;">⏳ Checking…</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">Bot account</div>
								<div class="discord-metric-username" style="font-size: 14px; font-weight: 600;">--</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">Messages received</div>
								<div class="discord-metric-recv" style="font-size: 14px; font-weight: 600;">0</div>
							</div>
							<div style="border: 1px solid var(--border); padding: 10px; border-radius: 4px; background: var(--bg);">
								<div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px;">Replies sent</div>
								<div class="discord-metric-sent" style="font-size: 14px; font-weight: 600;">0</div>
							</div>
						</div>
						<div class="discord-metric-commands" style="margin-top: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							Native commands: <code>/help</code>, <code>/status</code>, <code>/new</code>, <code>/cancel</code>, <code>/cwd</code>, <code>/model</code>, <code>/system</code>, <code>/context</code>, <code>/read</code>, and <code>/pi</code>. <code>/model</code> takes an optional model and an optional thinking level. The <code>/cwd</code> and <code>/model</code> options support autocomplete. Commands are registered globally and per guild, so they also work in DMs when the app is installed to a user account.
							<br />
							<code>/read [count]</code> loads the last messages of the current channel into the chat context without starting a turn, and <code>/pi <message> [context]</code> sends a prompt to the agent just like an <code>@mention</code> — which is the way to talk to it in a personal DM. The <code>context</code> option of <code>/pi</code> sets how many recent channel messages are included (default 5).
							<br />
							<code>/context</code> shows the loaded context and <code>/context clear</code> drops it. The loaded context travels with every later prompt, wherever you send it from, until it is cleared.
						</div>
						<div class="discord-metric-detail" style="margin-top: 6px; font-size: 12px; color: var(--text-dim); line-height: 1.5;"></div>
						<div style="margin-top: 8px; font-size: 12px; color: var(--text-dim); line-height: 1.5;">
							The bot uses Discord's outbound Gateway WebSocket, so no public IP or reverse proxy is required. Each Discord user gets an isolated, persistent pi-web-ui conversation.
						</div>
					</div>

					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 8px;">👤 Install to a user account</div>
						<div class="discord-user-install-detail" style="font-size: 12px; color: var(--text-dim); line-height: 1.5; margin-bottom: 10px;">
							Global commands: <span class="discord-metric-global">unknown</span>. Users who add the app to their own account can use it in every server, DM, and group chat they have.
						</div>
						<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
							<input type="text" class="discord-user-install-url" readonly style="flex: 1; min-width: 220px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text-dim); font-size: 11px; outline: none;" />
							<button type="button" class="discord-btn-copy-user-install" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer; font-size: 12px;">Copy install link</button>
						</div>
					</div>

					<div style="border: 1px solid var(--border); border-radius: 6px; padding: 16px; background: var(--bg-elev);">
						<div style="font-weight: 600; font-size: 14px; margin-bottom: 12px;">📤 Send a Discord message</div>
						<div style="display: flex; flex-direction: column; gap: 10px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Target channel ID</label>
								<input type="text" class="discord-send-channelid" placeholder="123456789012345678 (leave empty for default)" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Message text (Markdown supported)</label>
								<textarea class="discord-send-text" rows="3" placeholder="Enter the message to send…" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
							</div>
							<div style="display: flex; justify-content: flex-end;">
								<button class="discord-btn-send" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">🚀 Send message</button>
							</div>
						</div>
					</div>
				</div>

				<div class="discord-modal-settings" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
					<div style="width: 520px; max-width: 90vw; max-height: 85vh; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
						<div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<span style="font-weight: 600;">🎮 Discord bot configuration</span>
							<button class="discord-modal-close" style="background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 16px;">✕</button>
						</div>
						<div style="padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;">
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Bot Token (encrypted at rest)</label>
								<input type="password" class="discord-cfg-token" placeholder="Enter the Bot Token" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								<div style="margin-top: 4px; font-size: 11px; color: var(--text-dim);">Create an application and bot in the Discord Developer Portal. Enable the Message Content Intent.</div>
							</div>
							<div>
								<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Default channel ID (optional)</label>
								<input type="text" class="discord-cfg-default-channel" placeholder="123456789012345678" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
							</div>
							<div style="border-top: 1px solid var(--border); padding-top: 12px;">
								<div style="font-weight: 600; margin-bottom: 8px;">🤖 Gateway and access control</div>
								<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
									<input type="checkbox" id="discord-cfg-bot-enabled" class="discord-cfg-bot-enabled" style="cursor: pointer;" />
									<label for="discord-cfg-bot-enabled" style="font-size: 12px; cursor: pointer; user-select: none;">Enable the Discord bot service</label>
								</div>
								<div style="margin-bottom: 8px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Allowed Discord User IDs (comma-separated; empty allows everyone)</label>
									<input type="text" class="discord-cfg-allowed-users" placeholder="1234567890, 9876543210" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div>
									<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
										<label style="color: var(--text-dim);">📂 Default workspace directory</label>
									</div>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="discord-cfg-workspace" placeholder="/path/to/project" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<select class="discord-cfg-ws-select" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">Select a known project…</option>
										</select>
										<button type="button" class="discord-cfg-ws-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">📂 Browse…</button>
										<button type="button" class="discord-cfg-use-cwd" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">Use current project</button>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">✨ AI model and thinking level (empty follows the host default)</label>
									<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
										<input type="text" class="discord-cfg-model" placeholder="provider/model" style="flex: 2; min-width: 180px; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;" />
										<button type="button" class="discord-cfg-model-browse" style="padding: 6px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-elev2); color: var(--text); cursor: pointer;">✨ Choose model…</button>
										<select class="discord-cfg-thinking" style="min-width: 130px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; outline: none;">
											<option value="">Thinking: follow host</option>
											<option value="off">Thinking: off</option>
											<option value="low">Thinking: low</option>
											<option value="medium">Thinking: medium</option>
											<option value="high">Thinking: high</option>
											<option value="max">Thinking: max</option>
										</select>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">💬 Automatic replies</label>
									<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
										<input type="checkbox" id="discord-cfg-auto-reply" class="discord-cfg-auto-reply" style="cursor: pointer;" />
										<label for="discord-cfg-auto-reply" style="font-size: 12px; cursor: pointer; user-select: none;">Answer every message in the default channel (no @mention needed)</label>
									</div>
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">Extra automatic-reply channel IDs (comma-separated)</label>
									<input type="text" class="discord-cfg-auto-reply-channels" placeholder="123456789012345678" style="width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);" />
								</div>
								<div style="margin-top: 10px;">
									<label style="display: block; margin-bottom: 4px; color: var(--text-dim);">🧠 Discord core system prompt</label>
									<textarea class="discord-cfg-system-prompt" rows="3" placeholder="Leave empty to use the built-in core prompt" style="width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); resize: vertical; font-family: inherit;"></textarea>
								</div>
								<div style="margin-top: 10px;">
									<div style="display: flex; align-items: center; gap: 8px;">
										<input type="checkbox" id="discord-cfg-workspace-session" class="discord-cfg-workspace-session" style="cursor: pointer;" />
										<label for="discord-cfg-workspace-session" style="font-size: 12px; cursor: pointer; user-select: none;">Reuse the pi session open in pi-web-ui for this workspace</label>
									</div>
								</div>
								<div style="margin-top: 10px;">
									<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
										<input type="checkbox" id="discord-cfg-show-tool-calls" class="discord-cfg-show-tool-calls" style="cursor: pointer;" />
										<label for="discord-cfg-show-tool-calls" style="font-size: 12px; cursor: pointer; user-select: none;">Show tool calls and thinking steps while the agent works</label>
									</div>
									<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
										<input type="checkbox" id="discord-cfg-live-reply" class="discord-cfg-live-reply" style="cursor: pointer;" />
										<label for="discord-cfg-live-reply" style="font-size: 12px; cursor: pointer; user-select: none;">Stream the answer into one live message (edited in place)</label>
									</div>
									<div style="display: flex; align-items: center; gap: 8px;">
										<input type="checkbox" id="discord-cfg-allow-attachments" class="discord-cfg-allow-attachments" style="cursor: pointer;" />
										<label for="discord-cfg-allow-attachments" style="font-size: 12px; cursor: pointer; user-select: none;">Let the model see files, images and custom emoji sent in Discord</label>
									</div>
									<div style="margin-top: 6px; font-size: 11px; color: var(--text-dim);">
										Attachments are downloaded into <code>.pi-web-discord/attachments</code> inside the workspace and deleted after 7 days. Images are handed to the model natively.
									</div>
								</div>
							</div>
						</div>
						<div style="padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-elev);">
							<button class="discord-btn-test-cfg" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">🔌 Test connection</button>
							<div style="display: flex; gap: 8px;">
								<button class="discord-modal-cancel" style="padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;">Cancel</button>
								<button class="discord-btn-save-cfg" style="padding: 6px 16px; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-contrast, #fff); cursor: pointer; font-weight: 500;">💾 Save configuration</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;

		const query = (selector) => element.querySelector(selector);
		const statusBadge = query(".discord-status-badge");
		const metricState = query(".discord-metric-state");
		const metricUsername = query(".discord-metric-username");
		const metricReceived = query(".discord-metric-recv");
		const metricSent = query(".discord-metric-sent");
		const modal = query(".discord-modal-settings");
		const metricGlobal = query(".discord-metric-global");
		const userInstallUrl = query(".discord-user-install-url");

		const configToken = query(".discord-cfg-token");
		const configDefaultChannel = query(".discord-cfg-default-channel");
		const configBotEnabled = query(".discord-cfg-bot-enabled");
		const configAllowedUsers = query(".discord-cfg-allowed-users");
		const configWorkspace = query(".discord-cfg-workspace");
		const configWorkspaceSelect = query(".discord-cfg-ws-select");
		const configWorkspaceBrowse = query(".discord-cfg-ws-browse");
		const configModel = query(".discord-cfg-model");
		const configModelBrowse = query(".discord-cfg-model-browse");
		const configThinking = query(".discord-cfg-thinking");
		const configAutoReply = query(".discord-cfg-auto-reply");
		const configAutoReplyChannels = query(".discord-cfg-auto-reply-channels");
		const configSystemPrompt = query(".discord-cfg-system-prompt");
		const configWorkspaceSession = query(".discord-cfg-workspace-session");
		const configShowToolCalls = query(".discord-cfg-show-tool-calls");
		const configLiveReply = query(".discord-cfg-live-reply");
		const configAllowAttachments = query(".discord-cfg-allow-attachments");


		let currentState = {};
		let refreshTimer = null;
		let refreshInFlight = false;

		function renderGatewayState(state) {
			const bot = state?.botStatus || {};
			if (bot.state === "connected") {
				statusBadge.textContent = "🟢 Connected";
				statusBadge.style.color = "var(--green, #22c55e)";
				metricState.textContent = "🟢 Connected";
				metricState.style.color = "var(--green, #22c55e)";
			} else if (bot.state === "connecting") {
				statusBadge.textContent = "🟡 Connecting";
				statusBadge.style.color = "var(--amber, #eab308)";
				metricState.textContent = "🟡 Connecting…";
				metricState.style.color = "var(--amber, #eab308)";
			} else if (bot.state === "error") {
				statusBadge.textContent = "🔴 Error";
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = "🔴 Connection error";
				metricState.style.color = "var(--red, #ef4444)";
			} else {
				statusBadge.textContent = "⚪ Stopped";
				statusBadge.style.color = "var(--text-dim)";
				metricState.textContent = "⚪ Stopped";
				metricState.style.color = "var(--text-dim)";
			}
			metricUsername.textContent = bot.botUsername ? `@${bot.botUsername}` : "--";
			metricReceived.textContent = String(bot.messagesReceived || 0);
			metricSent.textContent = String(bot.messagesReplied || 0);
			if (metricGlobal) {
				metricGlobal.textContent = bot.registeredGlobally ? "registered" : "not registered";
			}
			if (userInstallUrl) {
				const applicationId = String(bot.applicationId || "").trim();
				userInstallUrl.value = applicationId
					? `https://discord.com/oauth2/authorize?client_id=${applicationId}&integration_type=1&scope=applications.commands`
					: "Connect the bot to generate a user-install link.";
			}
		}

		async function refresh() {
			if (refreshInFlight) return;
			refreshInFlight = true;
			try {
				const state = await sendHost("get_state");
				if (!state) throw new Error("The plugin host returned no state.");
				currentState = state;
				renderGatewayState(state);
				const detail = query(".discord-metric-detail");
				if (detail) {
					const config = state.config || {};
					const channels = Array.isArray(config.autoReplyChannels) ? config.autoReplyChannels : [];
					const automatic = channels.length
						? channels.join(", ")
						: config.autoReplyEnabled
							? config.defaultChannelId || "none"
							: "none";
					detail.textContent = [
						`Workspace: ${config.workspace || state.hostCwd || "(host default)"}`,
						`Model: ${config.model || "(host default)"}`,
						`Thinking: ${config.thinkingLevel || "(host default)"}`,
						`Core prompt: ${config.systemPrompt ? config.systemPromptMode || "replace" : "built-in"}`,
						`Automatic reply channels: ${automatic}`,
						`Workspace session reuse: ${config.useWorkspaceSession === false ? "off" : "on"}`,
						`Tool trace: ${config.showToolCalls ? "on" : "off"}`,
						`Live streaming: ${config.liveReplyEnabled ? "on" : "off"}`,
						`Attachments: ${config.allowAttachments ? "on" : "off"}`,
						`Stored sessions: ${Number(state.botStatus?.storedSessions || 0)}`,
					].join(" · ");
				}
			} catch (error) {
				statusBadge.textContent = "⚠️ Unreachable";
				statusBadge.style.color = "var(--red, #ef4444)";
				metricState.textContent = "⚠️ Host unreachable";
				metricState.style.color = "var(--red, #ef4444)";
				const detail = query(".discord-metric-detail");
				if (detail) detail.textContent = `Last error: ${error?.message || String(error)}`;
			} finally {
				refreshInFlight = false;
			}
		}

		query(".discord-btn-config").addEventListener("click", () => {
			const config = currentState.config || {};
			configToken.value = "";
			configToken.placeholder = config.hasBotToken
				? "●●●●●● (encrypted and saved; leave empty to keep it)"
				: "Enter the Bot Token";
			configDefaultChannel.value = config.defaultChannelId || "";
			configBotEnabled.checked = Boolean(config.botEnabled);
			configAllowedUsers.value = Array.isArray(config.allowedUsers)
				? config.allowedUsers.join(", ")
				: "";
			configWorkspace.value = config.workspace || "";
			configModel.value = config.model || "";
			configThinking.value = config.thinkingLevel || "";
			configAutoReply.checked = Boolean(config.autoReplyEnabled);
			configAutoReplyChannels.value = Array.isArray(config.autoReplyChannels)
				? config.autoReplyChannels.join(", ")
				: "";
			configSystemPrompt.value = config.systemPrompt || "";
			configWorkspaceSession.checked = config.useWorkspaceSession !== false;
			configShowToolCalls.checked = Boolean(config.showToolCalls);
			configLiveReply.checked = Boolean(config.liveReplyEnabled);
			configAllowAttachments.checked = Boolean(config.allowAttachments);


			try {
				const projects = globalThis.window?.__piWebUiHost?.listProjects?.() || [];
				configWorkspaceSelect.innerHTML = '<option value="">Select a known project…</option>';
				for (const project of projects) {
					if (!project) continue;
					const name = project.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || project;
					const option = document.createElement("option");
					option.value = project;
					option.textContent = `${name} (${project})`;
					configWorkspaceSelect.appendChild(option);
				}
			} catch {}

			modal.style.display = "flex";
		});

		query(".discord-cfg-use-cwd")?.addEventListener("click", () => {
			if (currentState.hostCwd) configWorkspace.value = currentState.hostCwd;
		});
		configWorkspaceSelect?.addEventListener("change", () => {
			if (configWorkspaceSelect.value) configWorkspace.value = configWorkspaceSelect.value;
		});
		configWorkspaceBrowse?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickDirectory !== "function") return;
			const result = await host.pickDirectory({
				title: "Choose the Discord bot workspace directory",
				initialPath: configWorkspace.value.trim() || currentState.hostCwd || "",
			});
			if (result?.ok && result.path) configWorkspace.value = result.path;
		});
		configModelBrowse?.addEventListener("click", async () => {
			const host = globalThis.window?.__piWebUiHost;
			if (typeof host?.pickModel !== "function") return;
			const result = await host.pickModel({
				currentModelId: configModel.value.trim() || undefined,
			});
			if (result?.ok && result.modelId) configModel.value = result.modelId;
		});
		query(".discord-modal-close").addEventListener("click", () => {
			modal.style.display = "none";
		});
		query(".discord-modal-cancel").addEventListener("click", () => {
			modal.style.display = "none";
		});

		query(".discord-btn-test-cfg").addEventListener("click", async () => {
			const button = query(".discord-btn-test-cfg");
			button.disabled = true;
			button.textContent = "Testing…";
			const result = await sendHost("test_config", { config: { botToken: configToken.value.trim() } });
			button.disabled = false;
			button.textContent = "🔌 Test connection";
			globalThis.alert?.(result?.message || (result?.success ? "Connection test passed." : "Connection test failed."));
		});

		query(".discord-btn-save-cfg").addEventListener("click", async () => {
			const button = query(".discord-btn-save-cfg");
			button.disabled = true;
			button.textContent = "Saving…";
			const config = {
				botToken: configToken.value.trim(),
				defaultChannelId: configDefaultChannel.value.trim(),
				botEnabled: Boolean(configBotEnabled.checked),
				allowedUsers: configAllowedUsers.value.split(/[,，;\s]+/).map((value) => value.trim()).filter(Boolean),
				workspace: configWorkspace.value.trim(),
				model: configModel.value.trim(),
				thinkingLevel: configThinking.value,
				autoReplyEnabled: Boolean(configAutoReply.checked),
				autoReplyChannels: configAutoReplyChannels.value
					.split(/[,，;\s]+/)
					.map((value) => value.trim())
					.filter(Boolean),
				systemPrompt: configSystemPrompt.value.trim(),
				systemPromptMode: configSystemPrompt.value.trim() ? "replace" : "",
				useWorkspaceSession: Boolean(configWorkspaceSession.checked),
				showToolCalls: Boolean(configShowToolCalls.checked),
				liveReplyEnabled: Boolean(configLiveReply.checked),
				allowAttachments: Boolean(configAllowAttachments.checked),
			};
			const result = await sendHost("save_config", { config });
			button.disabled = false;
			button.textContent = "💾 Save configuration";
			if (result?.success) {
				modal.style.display = "none";
				await refresh();
			} else {
				globalThis.alert?.(`Save failed: ${result?.message || "Unknown error"}`);
			}
		});

		query(".discord-btn-toggle-bot").addEventListener("click", async () => {
			const running = currentState.botStatus?.state === "connected";
			await sendHost(running ? "stop_bot" : "start_bot");
			await refresh();
		});

		query(".discord-btn-copy-user-install")?.addEventListener("click", async () => {
			const button = query(".discord-btn-copy-user-install");
			const url = String(userInstallUrl?.value || "").trim();
			if (!url || !url.startsWith("http")) {
				globalThis.alert?.("Connect the bot first to generate a user-install link.");
				return;
			}
			try {
				await globalThis.navigator?.clipboard?.writeText(url);
				if (button) button.textContent = "✓ Copied";
			} catch {
				if (userInstallUrl) {
					userInstallUrl.removeAttribute("readonly");
					userInstallUrl.select();
				}
			}
			if (button) {
				setTimeout(() => {
					button.textContent = "Copy install link";
				}, 1500);
			}
		});

		query(".discord-btn-send").addEventListener("click", async () => {
			const channelInput = query(".discord-send-channelid");
			const textInput = query(".discord-send-text");
			const text = textInput.value.trim();
			if (!text) {
				globalThis.alert?.("Enter the message text to send.");
				return;
			}
			const button = query(".discord-btn-send");
			button.disabled = true;
			button.textContent = "Sending…";
			try {
				const result = await sendHost("send_message", {
					channelId: channelInput.value.trim(),
					text,
				});
				if (result?.success) {
					globalThis.alert?.("✅ Discord message sent.");
					textInput.value = "";
				} else {
					globalThis.alert?.(`Send failed: ${result?.message || "Unknown error"}`);
				}
			} finally {
				button.disabled = false;
				button.textContent = "🚀 Send message";
			}
		});

		await refresh();
		refreshTimer = globalThis.setInterval?.(() => {
			void refresh();
		}, 4000) || null;
		return () => {
			if (refreshTimer) globalThis.clearInterval(refreshTimer);
			hostBridge.dispose();
		};
	},
};
