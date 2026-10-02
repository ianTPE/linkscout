const DEFAULTS = { workerUrl: "http://localhost:8787", token: "dev-token" };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS).then((v) => {
  $("workerUrl").value = v.workerUrl;
  $("token").value = v.token;
});

$("save").onclick = async () => {
  await chrome.storage.sync.set({ workerUrl: $("workerUrl").value.trim(), token: $("token").value });
  $("status").textContent = "Saved";
};
