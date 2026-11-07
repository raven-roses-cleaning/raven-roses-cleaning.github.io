(function () {
  "use strict";

  // Live backend: Google Apps Script web app that appends each submission
  // to the matching tab of the "Raven Forms — Submissions" Sheet.
  var FORM_ENDPOINT = "https://script.google.com/macros/s/AKfycbzJSTNksrCbxVDLmZI78JgB72DddKLnCCJlqAmDYnot9UpaV-ditN7ooGRSBIrdPlwt/exec";

  // Sheet column names per form (matches each tab's row-1 headers).
  var SHEET_FIELDS = {
    waitlist: { name: "Name", phone: "Phone", email: "Email", area: "Area", service: "Service", frequency: "Frequency", notes: "Home size / notes" },
    quote: { name: "Name", phone: "Phone", email: "Email", area: "Area", service: "Service", frequency: "Frequency", size: "Home size", notes: "Notes" },
    contact: { name: "Name", email: "Email", phone: "Phone", subject: "Subject", message: "Message" },
    hiring: { name: "Name", phone: "Phone", email: "Email", availability: "Availability", vehicle: "Own vehicle", pets: "Comfortable around cats and dogs", experience: "Experience note" },
    newsletter: { name: "Name", email: "Email", phone: "Phone", optin: "Opt-in" }
  };

  // ---- Failure logging, added 2026-11-05 (Coopers) ----
  // The Coopers tried to sign up and got a failure message, and left NO
  // trace anywhere — no sheet row, no email, no log — so Krystal had no
  // way to know, or to contact them. From now on EVERY submit attempt is
  // logged, not just successes.
  // Layers (honest limits — read the handover note):
  //  1. Client log: every attempt is written to localStorage on the
  //     visitor's own device (key ravenFormsAttemptsV1) as "pending",
  //     then updated to "sent" or "unconfirmed". This alone does NOT
  //     reach Krystal — it is only visible on that device.
  //  2. Failure report to the server: on timeout / unconfirmed, the app
  //     posts a second, separate form (formType "attempt-log") to the
  //     same Apps Script endpoint, with AttemptStatus "FAILED_UNCONFIRMED".
  //     The Apps Script MUST be updated to handle formType "attempt-log"
  //     (append to a "Failed attempts" tab + email Krystal) — the exact
  //     Code.gs snippet is in gazette-signup-fix-2026-11-05.md. Until
  //     that script change is deployed, that report POST may be ignored
  //     by the script, so it is NOT the only channel.
  //  3. User fallback (works today, no script change needed): on
  //     unconfirmed, the confirmation screen tells the visitor plainly
  //     to tap "Email this inquiry instead" — that mailto opens with
  //     their details pre-filled, so Krystal receives their signup by
  //     email even if the form failed.
  var ATTEMPT_LOG_KEY = "ravenFormsAttemptsV1";
  function logAttempt(attempt) {
    try {
      var list = JSON.parse(localStorage.getItem(ATTEMPT_LOG_KEY) || "[]");
      var i, found = false;
      for (i = 0; i < list.length; i++) {
        if (list[i].id === attempt.id) { list[i] = attempt; found = true; break; }
      }
      if (!found) list.push(attempt);
      localStorage.setItem(ATTEMPT_LOG_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) { /* private mode / storage blocked — do not break submit */ }
  }
  function sendFailureReport(attempt) {
    // Second hidden-iframe POST, separate from the original submission,
    // so a failed attempt is reported even if the first POST never ran.
    try {
      var iframe = document.createElement("iframe");
      iframe.name = "raven-forms-failure-target";
      iframe.style.display = "none";
      iframe.setAttribute("aria-hidden", "true");
      document.body.appendChild(iframe);
      var f = document.createElement("form");
      f.method = "POST";
      f.action = FORM_ENDPOINT;
      f.target = "raven-forms-failure-target";
      f.style.display = "none";
      var fields = {
        formType: "attempt-log",
        "AttemptStatus": "FAILED_UNCONFIRMED",
        "AttemptId": attempt.id,
        "AttemptTime": attempt.time,
        "OriginalForm": attempt.form,
        "Name": attempt.name,
        "Email": attempt.email,
        "Error": attempt.error || "iframe did not confirm within 60 seconds"
      };
      Object.keys(fields).forEach(function (k) {
        var input = document.createElement("input");
        input.type = "hidden";
        input.name = k;
        input.value = fields[k];
        f.appendChild(input);
      });
      document.body.appendChild(f);
      f.submit();
    } catch (e) { /* reporting must never break the user message */ }
  }

  // POST the submission to the web app via a hidden iframe + plain form.
  // FIX 2026-11-05 (Gazette signup failure — Coopers / Randy & Barbara):
  // the old code used fetch(..., { mode: "no-cors" }). The Apps Script
  // endpoint answers a POST with a 302 redirect to script.googleusercontent.com,
  // and following that redirect with a POST returns HTTP 411 Length Required
  // (verified 2026-11-05 with curl -L). In several browsers that redirect
  // chain makes fetch reject, so the user saw "We could not send your inquiry
  // just now" even though the Apps Script doPost had already run — or, with
  // an opaque no-cors response, the user could see "Sent" when the save had
  // actually failed. Either way the code could not tell success from failure.
  // A plain form POST targeted at a hidden iframe does not use fetch/CORS at
  // all: the browser posts the form, the Apps Script runs and appends the row,
  // and its response page loads in the iframe. The iframe load event is the
  // real "it arrived" signal. If the iframe has not loaded after the timeout,
  // we say so honestly instead of claiming success or failure.
  // TIMEOUT 2026-11-07: raised 20s -> 60s. Curl timing probes on 2026-11-07
  // showed doPost itself takes 9-31s to answer (and sometimes hangs >90s),
  // across ALL formTypes including quote — so the old 20s timeout fired
  // before the server had even answered, even when the row then saved.
  // 60s covers the observed 23-31s cases; it cannot fix a server hang
  // (>90s). The real fix is server-side: make doPost fast — see
  // forms-fix-diagnosis-2026-11-07.md. Do NOT auto-retry a timed-out
  // submit: the first POST may already have saved, and a retry would
  // create a duplicate row.
  function sendSubmission(key, data, onDone) {
    var params = { formType: key };
    var map = SHEET_FIELDS[key] || {};
    Object.keys(map).forEach(function (f) { params[map[f]] = data[f] || ""; });
    // Log EVERY attempt before trying to save — see Failure logging above.
    var attempt = {
      id: "att-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      time: new Date().toISOString(),
      form: key,
      name: data.name || "",
      email: data.email || "",
      status: "pending",
      error: ""
    };
    logAttempt(attempt);
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      attempt.status = ok ? "sent" : "unconfirmed";
      if (!ok) attempt.error = "iframe did not confirm within 60 seconds";
      logAttempt(attempt);
      if (!ok) sendFailureReport(attempt);
      onDone(ok);
    }
    var timer = setTimeout(function () { finish(false); }, 60000);
    var iframe = document.createElement("iframe");
    iframe.name = "raven-forms-target";
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.addEventListener("load", function () {
      // Ignore the initial about:blank load; only count a load after submit.
      if (iframe.getAttribute("data-submitted") === "1") finish(true);
    });
    document.body.appendChild(iframe);
    var f = document.createElement("form");
    f.method = "POST";
    f.action = FORM_ENDPOINT;
    f.target = "raven-forms-target";
    f.style.display = "none";
    Object.keys(params).forEach(function (k) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = k;
      input.value = params[k];
      f.appendChild(input);
    });
    document.body.appendChild(f);
    iframe.setAttribute("data-submitted", "1");
    f.submit();
  }

  var FORMS = {
    waitlist: { title: "Waitlist Signup", fields: ["name", "phone", "email", "area", "service", "frequency", "notes"] },
    quote: { title: "Quote Request", fields: ["name", "phone", "email", "area", "service", "frequency", "size", "notes"] },
    contact: { title: "General Contact", fields: ["name", "email", "phone", "subject", "message"] },
    hiring: { title: "Hiring / Resume", fields: ["name", "phone", "email", "availability", "vehicle", "pets", "experience"] },
    newsletter: { title: "Newsletter Signup", fields: ["name", "email", "phone", "optin"] }
  };
  var LABELS = {
    name: "Full name", phone: "Phone", email: "Email", area: "Area / town",
    service: "Service type", frequency: "Frequency", size: "Home size",
    notes: "Home size / notes", subject: "Subject", message: "Message",
    availability: "Availability", vehicle: "Own vehicle?", pets: "Comfortable around cats and dogs?",
    experience: "Brief experience note",
    optin: "Opt-in"
  };

  function $(id) { return document.getElementById(id); }
  function showPanel(key) {
    Object.keys(FORMS).forEach(function (k) {
      $("panel-" + k).hidden = (k !== key);
    });
    $("confirmation").hidden = true;
    var tabs = document.querySelectorAll(".tab");
    tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-form") === key); });
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { showPanel(tab.getAttribute("data-form")); });
  });
  $("back-to-forms").addEventListener("click", function () { $("confirmation").hidden = true; });

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  Object.keys(FORMS).forEach(function (key) {
    var form = $("form-" + key);
    if (!form) return;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = {};
      FORMS[key].fields.forEach(function (f) {
        var el = form.elements[f];
        if (!el) { data[f] = ""; return; }
        if (el.type === "checkbox") { data[f] = el.checked ? "Yes, I want Raven & Roses updates by email" : ""; return; }
        data[f] = (el.value || "").trim();
      });
      // Validation: required fields + at least one contact method.
      var missing = [];
      if (!data.name) missing.push("Full name");
      form.querySelectorAll("[required]").forEach(function (el) {
        if (!el.value.trim()) {
          var label = LABELS[el.name] || el.name;
          if (missing.indexOf(label) === -1) missing.push(label);
        }
      });
      if (key === "newsletter" && !form.elements["optin"].checked) missing.push("the opt-in checkbox (Yes, I want Raven & Roses updates by email)");
      if (key !== "newsletter" && !data.phone && !data.email) missing.push("a phone number or an email address");
      if (key === "newsletter" && !data.email) missing.push("an email address");
      var oldErr = form.querySelector(".error");
      if (oldErr) oldErr.remove();
      if (missing.length) {
        var p = document.createElement("p");
        p.className = "error";
        p.textContent = "Please complete: " + missing.join(", ") + ".";
        form.prepend(p);
        return;
      }
      // Live mode: POST to the backend first, then show the summary + real confirmation.
      var submitBtn = form.querySelector("button[type=submit]");
      var btnLabel = submitBtn ? submitBtn.textContent : "";
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Sending…"; }
      sendSubmission(key, data, function (sent) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = btnLabel; }
        // Real sent confirmation.
        var status = $("send-status");
        if (!status) {
          status = document.createElement("p");
          status.id = "send-status";
          status.setAttribute("aria-live", "polite");
          var summary = $("summary");
          summary.parentNode.insertBefore(status, summary);
        }
        status.className = sent ? "sent" : "error";
        status.textContent = sent
          ? "Sent — thank you. Your inquiry was received by Raven & Roses and you will be contacted directly."
          : "We could not confirm your inquiry was received just now — it may still have saved. We tried to send Krystal a note that this attempt did not confirm, so she can follow up. To be sure she sees it, please tap \"Email this inquiry instead\" below — that opens your email app with your details pre-filled. Or call / text 778-268-4183.";
        // Render summary.
        var html = "<p><strong>Form:</strong> " + esc(FORMS[key].title) + "</p><dl>";
        FORMS[key].fields.forEach(function (f) {
          if (data[f]) html += "<dt>" + esc(LABELS[f] || f) + "</dt><dd>" + esc(data[f]) + "</dd>";
        });
        html += "</dl>";
        $("summary").innerHTML = html;
        $("resume-reminder").hidden = (key !== "hiring");
        // Mailto fallback: pre-filled email body, nothing auto-sent.
        var lines = [FORMS[key].title, ""];
        FORMS[key].fields.forEach(function (f) {
          if (data[f]) lines.push((LABELS[f] || f) + ": " + data[f]);
        });
        lines.push("", "This is an inquiry only. You will be contacted directly.");
        if (key === "hiring") lines.push("Resume: I will email my resume separately to ravenrosescleaning@gmail.com.");
        var subject = encodeURIComponent("Raven & Roses — " + FORMS[key].title + " — " + data.name);
        var body = encodeURIComponent(lines.join("\n"));
        $("email-instead").href = "mailto:ravenrosescleaning@gmail.com?subject=" + subject + "&body=" + body;
        Object.keys(FORMS).forEach(function (k) { $("panel-" + k).hidden = true; });
        $("confirmation").hidden = false;
        $("confirmation").scrollIntoView();
      });
    });
  });
})();
