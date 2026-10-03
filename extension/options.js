const DEFAULTS = { workerUrl: "http://localhost:8787", token: "dev-token", jobProfile: "", reorder: true, autoTranslate: true };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS).then((v) => {
  $("workerUrl").value = v.workerUrl;
  $("token").value = v.token;
  $("jobProfile").value = v.jobProfile;
  $("reorder").checked = v.reorder;
  $("autoTranslate").checked = v.autoTranslate;
});

$("save").onclick = async () => {
  await chrome.storage.sync.set({
    workerUrl: $("workerUrl").value.trim(),
    token: $("token").value,
    jobProfile: $("jobProfile").value.trim(),
    reorder: $("reorder").checked,
    autoTranslate: $("autoTranslate").checked,
  });
  $("status").textContent = "Saved";
};

// Fast mode is the optional <all_urls> permission itself, so it applies at once and Chrome's
// own record of it is the only state. Requesting it needs this click (a user gesture).
const ALL_SITES = { origins: ["<all_urls>"] };
chrome.permissions.contains(ALL_SITES).then((on) => ($("fastMode").checked = on));
$("fastMode").onchange = async (e) => {
  const ok = e.target.checked ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES);
  if (!ok) e.target.checked = !e.target.checked; // the user declined, or Chrome refused
};
