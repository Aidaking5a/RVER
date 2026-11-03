import { marked } from "/vendor/marked.js";
import { ConversationStream } from "./stream.js";

const $ = (id) => document.getElementById(id);
let sessionId = localStorage.getItem("rver-session-id");
let before = null;
let answerNode = null;
let answer = "";
let panel = "";
const status = (text) => {
  $("status").textContent = text;
};
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error ?? "Request failed");
  }
  return data;
}
const post = (url, body) =>
  api(url, { method: "POST", body: JSON.stringify(body) });
function showLogin() {
  stream.stop();
  $("app").hidden = true;
  $("login-panel").hidden = false;
  $("access-key").focus();
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderMarkdown(node, text) {
  node.innerHTML = DOMPurify.sanitize(
    marked.parse(text, { breaks: true, gfm: true }),
  );
  for (const link of node.querySelectorAll("a")) {
    link.rel = "noreferrer noopener";
    link.target = "_blank";
  }
}
function addMessage(text, role) {
  $("chat").querySelector(".empty")?.remove();
  const node = element("div", undefined, `message ${role}`);
  if (role === "assistant") renderMarkdown(node, text);
  else node.textContent = text;
  $("chat").append(node);
  $("chat").scrollTop = $("chat").scrollHeight;
  return node;
}
const stream = new ConversationStream({
  onState(busy) {
    $("send").disabled = busy;
    $("stop").disabled = !stream.active;
    if (!busy) {
      if ($("status").textContent.endsWith("…")) status("Stopped");
      $("message").focus();
    }
  },
  onError(error) {
    status(error.message);
  },
  onEvent(event) {
    if (event.type === "delta") {
      answer += event.token;
      answerNode ??= addMessage("", "assistant");
      renderMarkdown(answerNode, answer);
      $("chat").scrollTop = $("chat").scrollHeight;
      status("Responding…");
    }
    if (event.type === "tool") status(`Working: ${event.name}…`);
    if (event.type === "done") {
      answerNode ??= addMessage("", "assistant");
      renderMarkdown(answerNode, event.message);
      status(
        event.status === "waiting"
          ? "Waiting for your answer"
          : "Response complete",
      );
      void refreshSessions().catch((error) => status(error.message));
      void refreshEdits().catch((error) => status(error.message));
    }
  },
});
async function refreshSessions() {
  const { sessions } = await api("/api/sessions");
  $("conversation-list").replaceChildren();
  for (const session of sessions) {
    const button = element(
      "button",
      session.title,
      `conversation-item${session.id === sessionId ? " active" : ""}`,
    );
    button.onclick = () =>
      switchSession(session.id).catch((error) => status(error.message));
    $("conversation-list").append(button);
  }
}
async function switchSession(id, version = stream.beginNavigation()) {
  if (version !== stream.navigation) return;
  sessionId = id;
  localStorage.setItem("rver-session-id", id);
  $("chat").replaceChildren();
  $("edits").replaceChildren();
  $("earlier").hidden = true;
  $("sidebar").classList.remove("open");
  $("menu").setAttribute("aria-expanded", "false");
  try {
    const data = await api(`/api/sessions/${id}/messages`);
    if (version !== stream.navigation) return;
    before = data.before;
    $("earlier").hidden = before === null;
    for (const message of data.messages)
      addMessage(message.content, message.role);
    if (!data.messages.length)
      $("chat").append(
        element("p", "What would you like to work on?", "empty"),
      );
    status("Ready");
    await Promise.all([refreshSessions(), refreshEdits()]);
  } finally {
    stream.endNavigation(version);
  }
}
async function newChat() {
  const version = stream.beginNavigation();
  status("Opening chat…");
  try {
    const session = await post("/api/sessions", {});
    if (version === stream.navigation) await switchSession(session.id, version);
  } finally {
    stream.endNavigation(version);
  }
}
async function refreshEdits() {
  const id = sessionId;
  const { edits } = await api(`/api/sessions/${id}/edits`);
  if (id !== sessionId) return;
  $("edits").replaceChildren();
  for (const edit of edits) {
    const card = element("details", undefined, "edit-card");
    card.append(
      element("summary", `Review proposed edit: ${edit.path}`),
      element("p", "Replace:"),
      element("pre", edit.oldText),
      element("p", "With:"),
      element("pre", edit.newText),
    );
    for (const action of ["approve", "reject"]) {
      const button = element(
        "button",
        action === "approve" ? "Apply this edit" : "Reject",
      );
      button.onclick = async () => {
        button.disabled = true;
        try {
          await post(`/api/edits/${edit.id}`, { action });
          status(
            action === "approve"
              ? `Applied edit to ${edit.path}`
              : "Edit rejected",
          );
          await refreshEdits();
        } catch (error) {
          status(error.message);
          button.disabled = false;
        }
      };
      card.append(button);
    }
    $("edits").append(card);
  }
}
$("message-form").onsubmit = async (event) => {
  event.preventDefault();
  const message = $("message").value.trim();
  if (!message || stream.active || stream.navigating) return;
  addMessage(message, "user");
  $("message").value = "";
  answer = "";
  answerNode = null;
  status("Thinking…");
  await stream.start(`/api/sessions/${sessionId}/stream`, {
    message,
    mode: $("edit-mode").checked ? "edit" : "inspect",
  });
};
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!stream.active && !stream.navigating) $("message-form").requestSubmit();
  }
};
$("stop").onclick = () => {
  stream.stop();
  status("Stopped");
};
$("new-chat").onclick = async () => {
  stream.stop();
  $("new-chat").disabled = true;
  try {
    await newChat();
  } catch (error) {
    status(error.message);
  } finally {
    $("new-chat").disabled = false;
  }
};
$("earlier").onclick = async () => {
  const version = stream.navigation;
  try {
    const data = await api(
      `/api/sessions/${sessionId}/messages?before=${before}`,
    );
    if (version !== stream.navigation) return;
    const previous = [...$("chat").children];
    $("chat").replaceChildren();
    for (const message of data.messages)
      addMessage(message.content, message.role);
    $("chat").append(...previous);
    before = data.before;
    $("earlier").hidden = before === null;
  } catch (error) {
    status(error.message);
  }
};
$("menu").onclick = () => {
  const open = $("sidebar").classList.toggle("open");
  $("menu").setAttribute("aria-expanded", String(open));
};
$("logout").onclick = async () => {
  await post("/api/logout", {});
  showLogin();
};
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await post("/api/login", { token: $("access-key").value });
    $("access-key").value = "";
    await enterApp();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
};
async function enterApp() {
  await api("/api/me");
  $("login-panel").hidden = true;
  $("app").hidden = false;
  const { sessions } = await api("/api/sessions");
  const existing = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  if (existing) await switchSession(existing.id);
  else await newChat();
}

function form(label, submitText, onSubmit, maxLength = 1000) {
  const node = element("form", undefined, "tool-form");
  const id = crypto.randomUUID();
  const input = element("textarea");
  input.id = id;
  input.required = true;
  input.maxLength = maxLength;
  const title = element("label", label);
  title.htmlFor = id;
  const button = element("button", submitText);
  button.type = "submit";
  const error = element("p");
  error.setAttribute("role", "alert");
  node.append(title, input, button, error);
  node.onsubmit = async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await onSubmit(input.value);
      input.value = "";
    } catch (e) {
      error.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  return node;
}
async function showPanel(name) {
  panel = name;
  $("dialog-title").textContent = {
    memory: "Memory",
    tasks: "Tasks",
    runs: "Run history",
  }[name];
  $("dialog-content").replaceChildren();
  if (!$("tools-dialog").open) $("tools-dialog").showModal();
  const content = $("dialog-content");
  if (name === "memory")
    content.append(
      element(
        "p",
        "Save notes RVER should remember across your chats. Notes are saved only when you ask.",
      ),
      form("Note to remember", "Save memory", async (text) => {
        await post("/api/memories", { text });
        await showPanel("memory");
      }),
    );
  if (name === "tasks")
    content.append(
      element(
        "p",
        "Read-only tasks continue while the gateway runs. Questions and interrupted work wait for you.",
      ),
      form(
        "Task to queue",
        "Queue task",
        async (message) => {
          await post("/api/tasks", { message });
          await refreshRecords();
        },
        12000,
      ),
    );
  const records = element("div");
  records.id = "records";
  content.append(records);
  await refreshRecords();
}
async function refreshRecords() {
  if (
    !$("tools-dialog").open ||
    (document.activeElement?.matches("input,textarea") &&
      document.activeElement.closest("[data-task]"))
  )
    return;
  const requested = panel;
  const data = await api(
    `/api/${{ memory: "memories", tasks: "tasks", runs: "runs" }[panel]}`,
  );
  if (requested !== panel || !$("tools-dialog").open) return;
  const container = $("records");
  container.replaceChildren();
  const records = data.memories ?? data.tasks ?? data.runs;
  if (!records.length) container.append(element("p", "Nothing here yet."));
  for (const record of records.sort((a, b) =>
    (b.createdAt ?? b.startedAt).localeCompare(a.createdAt ?? a.startedAt),
  )) {
    const card = element("article", undefined, "record");
    if (requested === "memory") {
      card.append(element("p", record.text));
      const forget = element("button", "Forget");
      forget.onclick = async () => {
        await api(`/api/memories/${record.id}`, { method: "DELETE" });
        await refreshRecords();
      };
      card.append(forget);
    } else if (requested === "tasks") {
      card.dataset.task = record.id;
      card.append(
        element("strong", record.status),
        element("p", record.result ?? record.message),
      );
      const open = element("button", "Open conversation");
      open.onclick = () => {
        $("tools-dialog").close();
        void switchSession(record.sessionId);
      };
      card.append(open);
      if (record.status === "waiting")
        card.append(
          form(
            record.question ?? "Your answer",
            "Answer and resume",
            async (answer) => {
              await post(`/api/tasks/${record.id}`, {
                action: "resume",
                answer,
              });
              document.activeElement.blur();
              await refreshRecords();
            },
            12000,
          ),
        );
      if (["interrupted", "failed"].includes(record.status)) {
        const resume = element("button", "Resume");
        resume.onclick = async () => {
          await post(`/api/tasks/${record.id}`, { action: "resume" });
          await refreshRecords();
        };
        card.append(resume);
      }
      if (
        ["queued", "running", "waiting", "interrupted"].includes(record.status)
      ) {
        const cancel = element("button", "Cancel");
        cancel.onclick = async () => {
          await post(`/api/tasks/${record.id}`, { action: "cancel" });
          document.activeElement.blur();
          await refreshRecords();
        };
        card.append(cancel);
      }
    } else {
      card.append(
        element("strong", `${record.status} · ${record.calls} model calls`),
        element(
          "p",
          `${new Date(record.startedAt).toLocaleString()} · ${record.usage.input} input / ${record.usage.output} output tokens`,
        ),
        element(
          "p",
          record.tools
            .map(
              (t) =>
                `${t.name}: ${t.success ? "ok" : "failed"} (${t.durationMs} ms)`,
            )
            .join(" · ") || "No tools used",
        ),
      );
    }
    container.append(card);
  }
}
for (const button of document.querySelectorAll("[data-panel]"))
  button.onclick = () =>
    showPanel(button.dataset.panel).catch((error) => status(error.message));
$("dialog-close").onclick = () => $("tools-dialog").close();
setInterval(() => {
  if (panel === "tasks" && $("tools-dialog").open)
    void refreshRecords().catch(() => {});
}, 2500);
enterApp().catch((error) => {
  showLogin();
  if (!error.message.includes("Sign in"))
    $("login-error").textContent = error.message;
});
