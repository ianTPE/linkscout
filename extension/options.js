const DEFAULTS = { workerUrl: "http://localhost:8787", token: "dev-token", jobProfile: "" };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS).then((v) => {
  $("workerUrl").value = v.workerUrl;
  $("token").value = v.token;
  $("jobProfile").value = v.jobProfile;
});

$("save").onclick = async () => {
  await chrome.storage.sync.set({
    workerUrl: $("workerUrl").value.trim(),
    token: $("token").value,
    jobProfile: $("jobProfile").value.trim(),
  });
  $("status").textContent = "Saved";
};
