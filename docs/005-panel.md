# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Language

The panel supports English, Chinese and Korean. Choose **한국어** in DeepSeek Harness's **Settings → General → Language** (**설정 → 일반 → 언어**) to use Korean. When the plugin adds Korean to the shared language selector, it also registers the host UI language pack for DSH 0.2.1-rc.3, covering the sidebar, conversation, settings, plugins and tools. A separately installed Korean language pack retains ownership of host translations. Host text introduced in newer releases falls back to English. The glossary pairs Korean terms with their English equivalents. The bundle's two managed presets have Korean names and dedicated-session warnings; DSH's preset metadata accepts plain strings, so this copy stays Korean across UI languages. Other package-provided names without Korean metadata, user-written messages, saved prompt contents and agent instructions keep their original text.

## Grok subscription sign-in

Open the host's **Settings → Models → Add model provider → External model provider** (**설정 → 모델 → 모델 제공업체 추가 → 외부 모델 제공업체**), then select **xai** in the provider list. **Grok subscription** (**Grok 구독**) appears within that provider's card alongside its existing API-key editor. Select **Sign in with Grok** to open a separate xAI sign-in window (`accounts.x.ai` or `auth.x.ai`), then approve the user-facing code there. The window is reserved during the click and navigates only after that attempt supplies a trusted verification URL. If the browser blocks the window or you close it while it is loading, use **Open xAI sign-in** in the original card. Reopening Settings or receiving background status updates preserves the manual link without opening another window. The card polls for completion; closing Settings or switching providers preserves the bounded attempt so it can be reopened by selecting xai again. Once xAI is configured, expand **Grok subscription · Manage subscription** in its provider row to access the same subscription status, activation and sign-out controls. Cancel stops waiting, and an expired or failed attempt can be retried. The displayed time is the application's ten-minute waiting limit, not the provider's device-code expiry.

The installed host must provide native authorization, a writable credential store, and the pi-ai xAI OAuth flow. Credentials stay in DSH's native credential store and refresh through the existing adapter; the panel receives status, verification URL and user code only. A stored sign-in confirms credential presence. Account entitlement, model access and successful inference require a real request and are not established by this screen.

Signing in leaves the model-provider configuration unchanged. After sign-in, select **Use subscription for xAI models** to add the native xAI provider. Switching an existing `apiKeyEnv` route requires confirmation; its API-key value and other providers remain stored. An API-key reference inherited from a lower configuration layer requires removal in that source layer; the card explains this and blocks activation, because the native unset operation resets a field to its inherited value. Custom xAI endpoints, protocols and request headers are preserved and are not activated by this card. Existing model selections stay unchanged: choose a Grok model separately in the chat selector or the Superagent assessment/executor settings. A separately saved xAI API-key credential requires explicit replacement confirmation before sign-in.

**Sign out of subscription** removes only the local saved xAI grant after confirmation. It does not revoke the grant at the issuer or remove provider settings. An environment API key can become effective afterward, so sign-out does not promise that all future xAI requests stop. Native cancellation can race an already admitted credential write; the card refreshes actual stored status instead of deleting credentials to undo a completed login.

These operations use the same loopback/same-origin management boundary as the Superagent panel. When a deployment exposes that panel through a tokenless proxy, anyone with management access can manage this login too. Protect the deployment's network access before storing a personal subscription credential. The feature does not import Grok CLI credentials, start Grok CLI processes, or require ACP.

## Instances

When one DeepSeek Harness process runs several Superagent instances (006 Deployment, "Several instances in one profile"), a selector beside the panel title chooses the instance the whole panel manages. Each option shows the instance's repository (`owner/name`) and, for an instance other than the default one, its key; an instance without a repository shows its key, or **Default instance**. The panel reads the running instances every 15 seconds. With a single default instance, or on a host that does not list instances, the selector is hidden and the panel manages the default instance.

The browser remembers the selected instance, and each instance remembers its own last page. Switching instances reloads the panel at that page. An instance that is restarting, as after saving settings, briefly leaves the list: the panel stays on it and marks it **unavailable** until it answers again. The Deployment settings edit the selected instance's own plugin entry. The Grok subscription card in the host's model settings belongs to the whole process, not to an instance.

The Deployment settings also list every instance of the process, with its repository and management prefix. When the host can add instances, a form adds one by key: it previews the management prefix and state directory, writes the instance to the Harness profile and starts it without a restart. The panel then switches to the new instance, whose Overview shows its setup. When the Harness cannot start it yet, the form says the instance starts after a restart; when it cannot add instances at all, the section says why (no profile, no live profile reload, or no running default instance). With a single instance, the form warns that once a second one runs, commands outside any Superagent Session, such as the sidebar terminal, MCP servers and the Harness's own git, lose the agent's gh and git credentials until the Harness restarts with one instance. On a host that reports whether it can add instances, the instance selector ends in **Add instance…**, which opens these settings without switching. In the Plugin Manager the same section adds an instance and points to the panel's selector to open it.

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Source**, **Trigger**, **Eval**, **Execution**, and **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Tickets needing action, system problems, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
