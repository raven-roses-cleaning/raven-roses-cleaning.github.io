(function () {
  "use strict";
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
      // Render summary — prototype mode: nothing is sent anywhere.
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
      lines.push("", "This is an inquiry only. No booking is confirmed until Krystal confirms it. No start date is promised.");
      if (key === "hiring") lines.push("Resume: I will email my resume separately to ravenrosescleaning@gmail.com.");
      var subject = encodeURIComponent("Raven & Roses — " + FORMS[key].title + " — " + data.name);
      var body = encodeURIComponent(lines.join("\n"));
      $("email-instead").href = "mailto:ravenrosescleaning@gmail.com?subject=" + subject + "&body=" + body;
      Object.keys(FORMS).forEach(function (k) { $("panel-" + k).hidden = true; });
      $("confirmation").hidden = false;
      $("confirmation").scrollIntoView();
    });
  });
})();
