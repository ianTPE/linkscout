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
