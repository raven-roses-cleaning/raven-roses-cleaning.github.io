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
        "Error": attempt.error || "confirmation not received within 60 seconds"
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

  // POST the submission to the web app via a hidden iframe + plain form,
  // and CONFIRM it by polling the server for the saved row — NOT by
  // waiting for the iframe to load.
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
  // all: the browser posts the form and the Apps Script runs and appends the
  // row. That part still holds — the iframe POST is still how the data is
  // SENT (a fetch POST would hit the 411 redirect problem).
  // WHY THE IFRAME LOAD EVENT CANNOT BE THE CONFIRMATION (found 2026-11-07):
  // the server was fixed to answer in ~2s (Version 5: append first, email
  // via queue), yet Contact/Hiring/Newsletter still timed out at 60s even
  // though every row had saved. The iframe load event intermittently never
  // fires. Verified 2026-11-07 with curl: the final googleusercontent
  // response carries "X-Frame-Options: SAMEORIGIN" and
  // "Content-Security-Policy: frame-ancestors 'self'" — Google's response
  // page is NOT frameable cross-origin, so the browser cannot reliably load
  // it in the hidden iframe. The POST still executes server-side; only the
  // confirmation signal is lost. So the iframe load is kept only as a fast
  // path (if it happens to fire, confirm at once) and is NEVER the only
  // signal any more.
  // CONFIRMATION FIX 2026-11-07 — poll for the saved row:
  // every submission carries a unique AttemptId (already generated for the
  // local log and the failure report; now also sent with the POST). doPost
  // records that AttemptId in a new "Attempts" tab when it saves the row.
  // The client then polls doGet (?attemptId=...) every 3 seconds until the
  // row is found, or the 60s deadline passes. A GET is safe here: it is
  // followed as a plain GET (no 411 — that only ever applied to POST
  // redirects), and the endpoint answers GET with
  // "Access-Control-Allow-Origin: *" on both the 302 and the final
  // response (verified 2026-11-07 with curl), so fetch works cross-origin.
  // If fetch fails or the server still returns the old plain-text doGet,
  // the poll falls back to a JSONP <script> tag (?callback=...), which
  // needs no CORS at all. Polling only READS; it never re-sends the form.
  // TIMEOUT 2026-11-07: 60s overall deadline (raised from 20s — curl
  // timing probes showed doPost itself took 9-31s before the Version 5
  // server fix; doPost is now ~1-2s, so a found row should normally
  // confirm in ~5-8s). Do NOT auto-retry a timed-out submit: the first
  // POST may already have saved, and a retry would create a duplicate row.
  // The server also dedupes on AttemptId — see
  // forms-confirmation-fix-2026-11-07.md.
  function pollForSavedRow(attemptId, onFound) {
    // One poll cycle: try fetch GET first, fall back to JSONP.
    // Calls onFound(true) if the row is found, onFound(false) if the
    // server answered "not found yet" (or the check was inconclusive —
    // keep polling until the 60s deadline either way).
    var url = FORM_ENDPOINT + "?attemptId=" + encodeURIComponent(attemptId) + "&_=" + Date.now();
    var settled = false;
    function settle(found) {
      if (settled) return;
      settled = true;
      onFound(found);
    }
    function pollViaJsonp(onResult) {
      // JSONP fallback: a <script> tag is not subject to CORS.
      // doGet must support ?callback=... — see the fix note.
      var cbName = "ravenFormsCheck_" + String(attemptId).replace(/[^a-zA-Z0-9]/g, "") + "_" + Date.now().toString(36);
      var script = document.createElement("script");
      var jsonpDone = false;
      function jsonpSettle(result) {
        if (jsonpDone) return;
        jsonpDone = true;
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        onResult(result);
      }
      window[cbName] = function (payload) { jsonpSettle(payload && payload.found ? true : false); };
      script.onerror = function () { jsonpSettle(null); };
      script.src = FORM_ENDPOINT + "?attemptId=" + encodeURIComponent(attemptId) + "&callback=" + encodeURIComponent(cbName) + "&_=" + Date.now();
      document.body.appendChild(script);
      setTimeout(function () { jsonpSettle(null); }, 6000); // JSONP timeout: inconclusive
    }
    var controller = null;
    var fetchTimer = null;
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        fetchTimer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, 5000);
      }
      fetch(url, controller ? { signal: controller.signal } : {})
        .then(function (resp) { return resp.json(); })
        .catch(function () { return null; }) // bad / plain-text JSON -> fall through to JSONP
        .then(function (payload) {
          if (fetchTimer) clearTimeout(fetchTimer);
          if (payload && payload.found) { settle(true); return; }
          if (payload && typeof payload.found === "boolean") { settle(false); return; }
          // Fetch worked but gave no usable JSON (e.g. the old plain-text
          // doGet is still deployed) — try JSONP once this cycle.
          pollViaJsonp(function (result) { settle(result === true); });
        })
        .catch(function () {
          if (fetchTimer) clearTimeout(fetchTimer);
          pollViaJsonp(function (result) { settle(result === true); });
        });
    } catch (e) {
      pollViaJsonp(function (result) { settle(result === true); });
    }
  }

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
    // Send the AttemptId with the POST so doPost can record it in the
    // "Attempts" tab — that is what the confirmation poll looks up.
    params.AttemptId = attempt.id;
    var done = false;
    var pollTimer = null;
    function stopPolling() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }
    function finish(ok) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stopPolling();
      attempt.status = ok ? "sent" : "unconfirmed";
      if (!ok) attempt.error = "confirmation not received within 60 seconds";
      logAttempt(attempt);
      if (!ok) sendFailureReport(attempt);
      onDone(ok);
    }
    var timer = setTimeout(function () { finish(false); }, 60000);
    // Fast path (kept): if the iframe happens to load, confirm at once.
    // It is no longer the only signal — the poll below is the real one.
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
    // Real confirmation: poll doGet for the saved row. First poll 2s
    // after submit (doPost takes ~1-2s), then every 3s until found or
    // the 60s deadline. Each cycle settles exactly once, so polls never
    // overlap and never re-send the form.
    function schedulePoll(delayMs) {
      if (done) return;
      pollTimer = setTimeout(function () {
        if (done) return;
        pollForSavedRow(attempt.id, function (found) {
          if (done) return;
          if (found) { finish(true); return; }
          schedulePoll(3000);
        });
      }, delayMs);
    }
    schedulePoll(2000);
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
