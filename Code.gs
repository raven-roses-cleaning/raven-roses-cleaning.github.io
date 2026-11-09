// ============================================================================
// Raven & Roses — Employee System backend (Google Apps Script)
// ============================================================================
// WHAT THIS IS
//   The shared backend for the Raven & Roses employee (time card) app, the
//   manager app, and the payroll app. It stores everything in the "Raven
//   Employee System" Google Sheet (Raven account) and emails Krystal when
//   something needs her.
//
//   DO NOT deploy this file yourself from here — deployment is Krystal's
//   step. See BACKEND-SETUP.md in this same folder for the exact steps
//   (create the Apps Script project, paste this file, deploy as a web app,
//   copy the /exec URL into all three apps).
//   The payroll app also reads TD1 claim amounts, the CRA business number
//   and RP account number, paystub send records and remittance records
//   from here, and sends each employee their own paystub by email
//   (MailApp) with one tap per payday.
//
// HOW THE APPS TALK TO IT
//   - Reads use JSONP (doGet + a callback= parameter), because Apps Script
//     web apps do not send CORS headers and a normal fetch() cannot read
//     the reply. Login is a read, so it works over JSONP.
//   - Writes use fetch() with mode:'no-cors' (fire-and-forget, like the
//     colouring-book analytics). The apps cannot read the reply, so they
//     never wait on it — local save always happens first, the backend
//     write is a best-effort sync on top.
//
// SECURITY — READ THIS, IT IS HONEST, NOT MARKETING
//   - Employee codes and the manager code are stored as PLAIN TEXT in the
//     Employees tab / Settings tab of the Sheet. They are simple shared
//     secrets, not hashed passwords. Keep the Sheet private to the Raven
//     Google account and do not share it. If a code ever leaks, change it
//     in the Sheet (or in the manager app) and the old one stops working.
//   - The web app is deployed "Execute as: Me" with "Who has access:
//     Anyone", because the apps reach it without a Google sign-in. Anyone
//     who has the /exec URL can call it — but every write must carry a
//     valid session token, and every token is checked server-side against
//     the Employees tab (name + code + Active status). A revoked employee's
//     token stops working the moment Krystal sets Active to No.
//   - The ONE no-token write is signPackage (v5): new hires sign before
//     they have an app code, so it carries no token. It can only write a
//     Signatures row, save the signer's address + emergency contact on
//     their Employees row, and email Krystal the signature image — it
//     cannot read or change anything else.
//   - The ONE no-token read is getEmployerSignature (v5): the signing
//     page has no login, and this only returns Krystal's own stored
//     signature image so it can be shown on the agreement. It reads one
//     Settings cell and nothing else.
//   - A session token is a SHA-256 hash of (name + code + sheet ID). It is
//     deterministic — no token is stored anywhere — so changing a code
//     invalidates every token made with the old code at once.
//   - The apps never store a code. They store only the token, in
//     sessionStorage, which ends when the tab closes.
//   - There is NO SIN anywhere in this backend, in any tab, email or log.
//     Do not add one here. The SIN vault is a separate, later job and it
//     does not belong in this file.
//
// NO GPS. NO LOCATION. The apps never send a location to this backend.
// NO PAY CALCULATION in the employee app — pay estimates live in the
// manager app only, and real pay is the payroll app's job.
// PAYROLL: the payroll app reads time entries, mileage, rates and the CRA
// rate from this backend, emails each employee only their own paystub
// (PaystubSends tab records every send), and records monthly remittances
// (Remittances tab). It does NOT submit anything to CRA and stores no SIN.
// ============================================================================

var SPREADSHEET_ID = "1i1N2BVl8okzu0RDABtDOZakpxMEmRwsrAiTG45co4pg";
var NOTIFY_EMAIL = "RavenRosesCleaning@gmail.com";

// ---------------------------------------------------------------------------
// Small Sheet helpers
// ---------------------------------------------------------------------------
function ss() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}
function sheet(name) {
  return ss().getSheetByName(name);
}
// Returns all rows of a tab as objects keyed by the header row (row 1).
// Also returns each row's sheet row number as _row (2 = first data row).
function readTab(name) {
  var sh = sheet(name);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { _row: i + 1 };
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    out.push(obj);
  }
  return out;
}
// Appends one row, in the tab's header order. Missing fields become "".
function appendRow(name, obj) {
  var sh = sheet(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) {
    var v = obj[h];
    return (v === undefined || v === null) ? "" : v;
  });
  sh.appendRow(row);
  return sh.getLastRow();
}
// Updates one row (1-based sheet row number) from an object keyed by header.
function updateRow(name, rowNumber, obj) {
  var sh = sheet(name);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) {
    var v = obj[h];
    return (v === undefined || v === null) ? "" : v;
  });
  sh.getRange(rowNumber, 1, 1, row.length).setValues([row]);
}
// Finds the first data row where every key in `match` equals the row's value
// (compared as strings, trimmed). Returns the object (with _row) or null.
function findRow(name, match) {
  var rows = readTab(name);
  for (var i = 0; i < rows.length; i++) {
    var ok = true;
    for (var k in match) {
      if (String(rows[i][k] == null ? "" : rows[i][k]).trim() !== String(match[k]).trim()) { ok = false; break; }
    }
    if (ok) return rows[i];
  }
  return null;
}
// Upsert: update the first matching row, or append if there is none.
function upsertRow(name, match, obj) {
  var found = findRow(name, match);
  if (found) {
    var merged = {};
    for (var k in found) { if (k !== "_row") merged[k] = found[k]; }
    for (var k2 in obj) merged[k2] = obj[k2];
    updateRow(name, found._row, merged);
    return found._row;
  }
  var combined = {};
  for (var k3 in match) combined[k3] = match[k3];
  for (var k4 in obj) combined[k4] = obj[k4];
  return appendRow(name, combined);
}
// Adds any missing headers to a tab's header row (appends them at the
// end). Used when a new column is introduced (e.g. Address on the
// Employees tab) so older sheets pick it up without a manual edit.
function ensureColumns(name, headers) {
  var sh = sheet(name);
  if (!sh) return;
  var last = sh.getLastColumn();
  var existing = [];
  if (last > 0) existing = sh.getRange(1, 1, 1, last).getValues()[0].map(function (h) { return String(h).trim(); });
  while (existing.length && existing[existing.length - 1] === "") existing.pop();
  var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
  if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
}
function setting(key) {
  var row = findRow("Settings", { Key: key });
  return row ? String(row.Value == null ? "" : row.Value) : "";
}
function notify(subject, body) {
  try {
    MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
  } catch (e) {
    // Email failing must never break the write itself.
    Logger.log("notify failed: " + e);
  }
}

// ---------------------------------------------------------------------------
// Login / tokens
// ---------------------------------------------------------------------------
function findEmployee(name) {
  var rows = readTab("Employees");
  var want = String(name || "").trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Name || "").trim().toLowerCase() === want) return rows[i];
  }
  return null;
}
// Loose name match, the same rule as the payroll app's samePerson():
// the time card stores first names ("Ramona") and the Employees tab
// stores full names ("Ramona Cyre"). Matches on the full name, or when
// one is the first word of the other. Case-insensitive.
function samePerson(a, b) {
  var x = String(a || "").trim().toLowerCase(), y = String(b || "").trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  return x.indexOf(y + " ") === 0 || y.indexOf(x + " ") === 0;
}
function findEmployeeLoose(name) {
  var rows = readTab("Employees");
  for (var i = 0; i < rows.length; i++) {
    if (samePerson(rows[i].Name, name)) return rows[i];
  }
  return null;
}
function makeToken(name, code) {
  var raw = String(name).trim().toLowerCase() + "|" + String(code) + "|" + SPREADSHEET_ID;
  var hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  return Utilities.base64Encode(hash);
}
// Returns the employee object if the token is valid and the employee is
// still Active, otherwise null. Changing a code or revoking access breaks
// every token made with the old code at once.
function verifyToken(name, token) {
  if (!name || !token) return null;
  var emp = findEmployee(name);
  if (!emp) return null;
  if (String(emp.Active || "").trim().toLowerCase() !== "yes") return null;
  if (makeToken(emp.Name, emp.Code) !== String(token)) return null;
  return emp;
}
// Manager login: Krystal's Employees row (role Manager) with her code, OR
// the ManagerCode cell in Settings (same code, second place to set it).
function checkManagerLogin(code) {
  var krystal = findEmployee("Krystal McGee");
  if (krystal && String(krystal.Code || "") !== "" && String(code) === String(krystal.Code)) return krystal;
  var mc = setting("ManagerCode");
  if (mc !== "" && String(code) === mc) {
    return krystal || { Name: "Krystal McGee", Role: "Manager", Rate: "", Active: "Yes", Code: mc };
  }
  return null;
}
function checkLogin(name, code) {
  var emp = findEmployee(name);
  if (!emp) return { ok: false, error: "No employee with that name. Check the name and try again — or ask Krystal to add you." };
  if (String(emp.Active || "").trim().toLowerCase() !== "yes") return { ok: false, error: "This login has been revoked. Ask Krystal if you think that is a mistake." };
  if (String(emp.Code || "") === "") return { ok: false, error: "No code is set for this login yet. Ask Krystal to set your code first." };
  if (String(code) !== String(emp.Code)) return { ok: false, error: "Wrong code. Try again." };
  // First-time code: Krystal gives a random code; the employee replaces it
  // with their own 4-digit code the first time they sign in (changeCode).
  var mustChange = String(emp.TempCode || "").trim().toLowerCase() === "yes";
  return { ok: true, name: emp.Name, role: emp.Role || "Employee", rate: emp.Rate || "", token: makeToken(emp.Name, emp.Code), mustChangeCode: mustChange };
}

// ---------------------------------------------------------------------------
// doGet — reads (JSONP). e.parameter: action, callback, name, code, token.
// ---------------------------------------------------------------------------
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || "ping";
  var out = { ok: false, error: "Unknown action: " + action };
  try {
    if (action === "ping") {
      out = { ok: true, service: "Raven Employee System backend", time: new Date().toISOString() };
    } else if (action === "getEmployerSignature") {
      // No token: the signing page has no login. This only returns
      // Krystal's stored signature image (Settings, key
      // "EmployerSignature") so it can be shown on the agreement — or
      // "" if she has not saved one yet.
      out = { ok: true, signature: setting("EmployerSignature") };
    } else if (action === "login") {
      // Manager login uses the name "Krystal McGee" (or "Krystal") — the
      // manager app sends name=Krystal McGee.
      var nm = String(p.name || "").trim();
      if (nm.toLowerCase() === "krystal" || nm.toLowerCase() === "krystal mcgee") {
        var mgr = checkManagerLogin(p.code);
        if (mgr) out = { ok: true, name: "Krystal McGee", role: "Manager", rate: "", token: makeToken("Krystal McGee", String(mgr.Code || setting("ManagerCode"))), mustChangeCode: false };
        else out = { ok: false, error: "Wrong manager code. Try again." };
      } else {
        out = checkLogin(nm, p.code);
      }
    } else if (action === "changeCode") {
      // First sign-in with a temporary code: the employee creates their own
      // 4-digit code. Authenticated by the current (temporary) token.
      // Managers never go through this — they change their code in the
      // manager app / Settings instead.
      var emp2 = verifyToken(p.name, p.token);
      if (!emp2) {
        out = { ok: false, error: "Not signed in, or this login was revoked. Sign in again." };
      } else if (String(emp2.Role || "").toLowerCase() === "manager") {
        out = { ok: false, error: "Managers change their code in the manager app." };
      } else {
        var nc = String(p.newCode || "");
        if (!/^[0-9]{4}$/.test(nc)) {
          out = { ok: false, error: "Your new code must be exactly 4 digits." };
        } else {
          var em5 = {};
          for (var k7 in emp2) { if (k7 !== "_row") em5[k7] = emp2[k7]; }
          em5.Code = nc; em5.TempCode = "No";
          updateRow("Employees", emp2._row, em5);
          out = { ok: true, name: emp2.Name, role: emp2.Role || "Employee", token: makeToken(emp2.Name, nc) };
        }
      }
    } else if (action === "getData") {
      var emp = verifyToken(p.name, p.token);
      if (!emp) {
        out = { ok: false, error: "Not signed in, or this login was revoked. Sign in again." };
      } else {
        out = buildData(emp);
      }
    }
  } catch (err) {
    out = { ok: false, error: "Backend error: " + err };
  }
  var text = JSON.stringify(out);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + "(" + text + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}

function buildData(emp) {
  var isManager = String(emp.Role || "").toLowerCase() === "manager";
  // House instructions: { Client: {serviceTag, serviceNote, tasks, special, codes} }
  var houses = {};
  readTab("HouseInstructions").forEach(function (r) {
    if (!r.Client) return;
    houses[r.Client] = {
      serviceTag: r.ServiceTag || "", serviceNote: r.ServiceNote || "",
      tasks: r.Tasks || "", special: r.Special || "", codes: r.Codes || ""
    };
  });
  // Monthly focus: the latest row (by sheet order) is the current month.
  var focusRows = readTab("MonthlyFocus");
  var focus = { month: "", note: "", tasks: [], rotation: [] };
  if (focusRows.length) {
    var f = focusRows[focusRows.length - 1];
    focus.month = f.Month || "";
    focus.note = f.Note || "";
    try { focus.tasks = JSON.parse(f.TasksJSON || "[]"); } catch (e) { focus.tasks = []; }
    try { focus.rotation = JSON.parse(f.RotationJSON || "[]"); } catch (e) { focus.rotation = []; }
  }
  // Guide: rebuild the {rooms:[], supplies:[]} shape the apps use.
  var guide = { note: "", rooms: [], supplies: [] };
  var roomMap = {};
  readTab("Guide").forEach(function (r) {
    if (r.Kind === "supply") {
      guide.supplies.push({
        id: r.ItemId || "", name: r.ItemName || "",
        goodFor: splitLines(r.GoodFor), how: r.How || "", notes: r.Notes || ""
      });
    } else if (r.Kind === "item") {
      if (!roomMap[r.RoomId]) {
        roomMap[r.RoomId] = { id: r.RoomId, name: r.RoomName || r.RoomId, items: [] };
        guide.rooms.push(roomMap[r.RoomId]);
      }
      roomMap[r.RoomId].items.push({
        id: r.ItemId || "", name: r.ItemName || "", supply: r.Supply || "",
        goodFor: splitLines(r.GoodFor), how: r.How || "", notes: r.Notes || "", tags: r.Tags || ""
      });
    }
  });
  var rates = {};
  readTab("Rates").forEach(function (r) { if (r.Employee) rates[r.Employee] = Number(r.Rate) || 0; });
  var cra = setting("CraRate");
  var data = {
    ok: true, role: emp.Role || "Employee", name: emp.Name,
    mustChangeCode: String(emp.TempCode || "").trim().toLowerCase() === "yes",
    houseInstructions: houses, monthlyFocus: focus, guide: guide,
    rates: rates, craRate: cra === "" ? "" : Number(cra),
    monthlyDone: readTab("MonthlyDone").map(stripRow),
    entries: [], adjustments: [], timeOff: [], mileage: [], mileageSubmissions: []
  };
  // Employees see their own rows; the manager sees everything.
  data.entries = readTab("Entries").filter(function (r) {
    return isManager || String(r.Employee || "").toLowerCase() === String(emp.Name).toLowerCase();
  }).map(stripRow);
  data.adjustments = readTab("Adjustments").filter(function (r) {
    return isManager || String(r.Employee || "").toLowerCase() === String(emp.Name).toLowerCase();
  }).map(stripRow);
  data.timeOff = readTab("TimeOff").filter(function (r) {
    return isManager || String(r.Employee || "").toLowerCase() === String(emp.Name).toLowerCase();
  }).map(stripRow);
  data.mileage = readTab("Mileage").filter(function (r) {
    return isManager || String(r.Employee || "").toLowerCase() === String(emp.Name).toLowerCase();
  }).map(stripRow);
  data.mileageSubmissions = readTab("MileageSubmissions").filter(function (r) {
    return isManager || String(r.Employee || "").toLowerCase() === String(emp.Name).toLowerCase();
  }).map(stripRow);
  // Work schedule: Krystal sets it in the manager app. Employees see only
  // their own rows; the manager sees everything.
  data.schedule = readTab("Schedule").filter(function (r) {
    return isManager || String(r.Employee || "").toLowerCase() === String(emp.Name).toLowerCase();
  }).map(stripRow);
  if (isManager) {
    data.employees = readTab("Employees").map(function (r) {
      var o = stripRow(r);
      // The paystub needs the employee's home address: expose it (and
      // the emergency contact) under lowercase names too, so the payroll
      // app can read them without guessing the Sheet's column casing.
      o.address = r.Address || "";
      o.emergencyContact = r.EmergencyContact || "";
      return o;
    });
    data.hasManagerCode = setting("ManagerCode") !== "";
    // Payroll app (manager only): TD1 claim amounts, CRA numbers, paystub
    // send records and remittance records. Employees never see these.
    data.td1Fed = setting("TD1Fed");
    data.td1Bc = setting("TD1Bc");
    data.businessNumber = setting("BusinessNumber");
    data.rpAccount = setting("RpAccount");
    data.paystubSends = readTab("PaystubSends").map(stripRow);
    data.remittances = readTab("Remittances").map(stripRow);
  }
  return data;
}
function stripRow(r) {
  var o = {};
  for (var k in r) { if (k !== "_row") o[k] = r[k]; }
  return o;
}
function splitLines(s) {
  return String(s || "").split(/\n|;/).map(function (x) { return x.trim(); }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// doPost — writes. Body is JSON: {action, name, token, ...fields}.
// Every action except "ping" and "signPackage" needs a valid token. The
// apps send these with fetch mode:'no-cors' and never read the reply —
// local save happens first in the app, this is the sync on top.
// "signPackage" needs no token: new hires sign before they have an app
// code, so there is no token to check yet. It only writes a Signatures
// row, saves the signer's address + emergency contact on their
// Employees row, and emails Krystal the signature image.
// ---------------------------------------------------------------------------
function doPost(e) {
  var out = { ok: false, error: "No data received" };
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var action = body.action || "";
    // Copy-attempt alerts are sent by the app when a copy is detected; they
    // still need a token so strangers cannot spam Krystal's inbox.
    var emp = verifyToken(body.name, body.token);
    if (!emp && action !== "ping" && action !== "signPackage") {
      out = { ok: false, error: "Not signed in, or this login was revoked." };
    } else {
      out = handleWrite(action, body, emp);
    }
  } catch (err) {
    out = { ok: false, error: "Backend error: " + err };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleWrite(action, b, emp) {
  var isManager = emp && String(emp.Role || "").toLowerCase() === "manager";
  switch (action) {
    case "ping":
      return { ok: true };

    case "signPackage": {
      // New-hire paperwork signing (v5) — NO token: the employee has no
      // app code yet. The signing page sends name, a PNG data URL of the
      // drawn signature, the date, the document names, the employee's
      // home address, and an emergency contact. It records the signing
      // in the Signatures tab, saves the address + emergency contact on
      // the employee's Employees row (for tax / T4 and the paystub), and
      // emails Krystal the signature image so she has the signed copy.
      var signer = String(b.name || "").trim();
      var sig = String(b.signature || "").trim();
      var addr = String(b.address || "").trim();
      var ec = b.emergencyContact || {};
      var ecName = String(ec.name || "").trim();
      var ecPhone = String(ec.phone || "").trim();
      var ecRel = String(ec.relationship || "").trim();
      if (!signer) return { ok: false, error: "Name is missing." };
      if (!addr) return { ok: false, error: "Home address is missing." };
      if (!ecName) return { ok: false, error: "Emergency contact name is missing." };
      if (!ecPhone) return { ok: false, error: "Emergency contact phone is missing." };
      if (!ecRel) return { ok: false, error: "Emergency contact relationship is missing." };
      if (!sig || sig.indexOf("data:image/png;base64,") !== 0) {
        return { ok: false, error: "Signature is missing." };
      }
      var docs = (b.documents || ["Employee Information Package", "Confidentiality Agreement"]).join("; ");
      var ecText = ecName + " — " + ecRel + " — " + ecPhone;
      // Save the address + emergency contact on the employee's row.
      // Do not fail if the employee is not in the Employees tab yet —
      // the signing is still recorded below and Krystal still gets the
      // email with the details in it.
      try {
        ensureColumns("Employees", ["Address", "EmergencyContact"]);
        var empRow = findEmployeeLoose(signer);
        if (empRow) {
          var emUp = {};
          for (var k in empRow) { if (k !== "_row") emUp[k] = empRow[k]; }
          emUp.Address = addr;
          emUp.EmergencyContact = ecText;
          updateRow("Employees", empRow._row, emUp);
        }
      } catch (e3) {
        Logger.log("signPackage employee update failed: " + e3);
      }
      // Record the signing (create the Signatures tab if it is not there).
      var sh = sheet("Signatures");
      if (!sh) {
        sh = ss().insertSheet("Signatures");
        sh.getRange(1, 1, 1, 6).setValues([["Date", "Employee", "Documents", "SentAt", "Address", "EmergencyContact"]]);
      } else {
        ensureColumns("Signatures", ["Address", "EmergencyContact"]);
      }
      appendRow("Signatures", {
        Date: b.date || "", Employee: signer, Documents: docs,
        SentAt: new Date().toISOString(), Address: addr, EmergencyContact: ecText
      });
      // Email Krystal the signature image as an attachment.
      try {
        var b64 = sig.replace("data:image/png;base64,", "");
        var blob = Utilities.newBlob(
          Utilities.base64Decode(b64), "image/png",
          "signature-" + signer.replace(/[^A-Za-z0-9]+/g, "-") + ".png");
        var subject = "Signed paperwork — " + signer + " — " + (b.date || "");
        var body = "Raven & Roses — signed employee paperwork\n\n" +
          "Employee: " + signer + "\n" +
          "Date signed: " + (b.date || "") + "\n" +
          "Documents signed: " + docs + "\n\n" +
          "Home address (for tax / T4 and the paystub):\n" + addr + "\n\n" +
          "Emergency contact: " + ecText + "\n\n" +
          "They signed BOTH the Employee Information Package and the Confidentiality Agreement.\n" +
          "The signature image is attached to this email.\n\n" +
          "A record is also in the Signatures tab of the Raven Employee System sheet.";
        MailApp.sendEmail(NOTIFY_EMAIL, subject, body, { attachments: [blob] });
      } catch (e2) {
        // The row is already recorded; say so plainly if the email failed.
        Logger.log("signPackage email failed: " + e2);
        return { ok: false, error: "Signed and recorded, but the email to Krystal failed: " + e2 };
      }
      return { ok: true };
    }

    case "saveEmployerSignature": {
      // Krystal saves her signature image (PNG data URL) so the signing
      // page can show it on the agreement — her saved signature IS the
      // employer signature, so the employee's copy is fully signed.
      // Manager only (needs a valid manager token). A separate piece of
      // work adds the draw-and-save UI to the manager app; this is only
      // the storage side. Stored in Settings, key "EmployerSignature".
      if (!isManager) return { ok: false, error: "Manager only." };
      var esig = String(b.signature || "").trim();
      if (!esig || esig.indexOf("data:image/png;base64,") !== 0) {
        return { ok: false, error: "Signature is missing." };
      }
      try {
        upsertRow("Settings", { Key: "EmployerSignature" }, { Key: "EmployerSignature", Value: esig });
      } catch (e3) {
        return { ok: false, error: "Could not save the signature: " + e3 };
      }
      return { ok: true };
    }

    case "clockin": {
      // One row per clock-in; clock-out fills the same row in later.
      appendRow("Entries", {
        Date: b.date, Employee: b.name, Job: b.job, ClockIn: b.in, ClockOut: "",
        Hours: "", Training: b.training ? "Yes" : "No", Issue: "", Refilled: "",
        LowItems: "", Stocked: "", Cloths: "", ChecklistDone: "", ChecklistItems: "",
        AdjustmentApproved: "", Source: "backend"
      });
      return { ok: true };
    }

    case "clockout": {
      var open = findRow("Entries", { Employee: b.name, Date: b.date, Job: b.job, ClockOut: "" });
      var row = {
        Date: b.date, Employee: b.name, Job: b.job, ClockIn: b.in, ClockOut: b.out,
        Hours: b.hours, Training: b.training ? "Yes" : "No", Issue: b.issue || "",
        Refilled: b.refilled ? "Yes" : "No", LowItems: (b.low || []).join("; "),
        Stocked: b.stocked ? "Yes" : "No", Cloths: b.cloth ? "Yes" : "No",
        ChecklistDone: b.checklistDone || "", ChecklistItems: b.checklistItems || "",
        AdjustmentApproved: "", Source: "backend"
      };
      if (open) updateRow("Entries", open._row, row);
      else appendRow("Entries", row);
      notify("Clock-out — " + b.name + " — " + b.job + " — " + b.date,
        "Raven & Roses — clock-out\n\nEmployee: " + b.name + "\nJob: " + b.job + "\nDate: " + b.date +
        "\nClock-in: " + fmtTime(b.in) + "\nClock-out: " + fmtTime(b.out) +
        "\nHours: " + b.hours + (b.training ? "\nTRAINING shift" : "") +
        "\nHome Completion List: " + (b.checklistDone || "not ticked off") +
        (b.issue ? "\nIssue note: " + b.issue : "") +
        "\nSupplies refilled: " + (b.refilled ? "yes" : "not confirmed") +
        "\nLow items: " + ((b.low || []).join("; ") || "none") +
        "\nCloths washed: " + (b.cloth ? "yes" : "not needed today"));
      return { ok: true };
    }

    case "checklist": {
      // Ticks sent during a job, before clock-out: attach to the open entry.
      var open2 = findRow("Entries", { Employee: b.name, Date: b.date, Job: b.job, ClockOut: "" });
      if (open2) {
        var merged = {};
        for (var k in open2) { if (k !== "_row") merged[k] = open2[k]; }
        merged.ChecklistDone = b.checklistDone || "";
        merged.ChecklistItems = b.checklistItems || "";
        updateRow("Entries", open2._row, merged);
      }
      return { ok: true };
    }

    case "adjust": {
      appendRow("Adjustments", {
        Date: b.date, Employee: b.name, Job: b.job, ReqIn: b.reqIn, ReqOut: b.reqOut,
        ReqHours: b.reqHours, Reason: b.reason, Status: "PENDING", DeclineReason: "",
        OrigIn: b.origIn || "", OrigOut: b.origOut || "", OrigHours: b.origHours || "",
        EntryIdx: "", Created: new Date().toISOString()
      });
      notify("Time adjustment request — " + b.name + " — " + b.job + " — " + b.date,
        "Raven & Roses — time adjustment request\n\nEmployee: " + b.name + "\nJob: " + b.job + "\nDate: " + b.date +
        "\nRequested: " + fmtTime(b.reqIn) + "–" + fmtTime(b.reqOut) + " (" + b.reqHours + "h)" +
        (b.origIn ? "\nOriginal: " + fmtTime(b.origIn) + "–" + fmtTime(b.origOut) + " (" + b.origHours + "h)" : "\nNew / missed shift") +
        "\nReason: " + b.reason + "\n\nApprove or decline it in the manager app.");
      return { ok: true };
    }

    case "decideAdjust": {
      if (!isManager) return { ok: false, error: "Manager only." };
      var adj = findRow("Adjustments", { Employee: b.employee, Date: b.date, Job: b.job, ReqIn: b.reqIn });
      if (!adj) return { ok: false, error: "Adjustment not found." };
      var a2 = {};
      for (var k2 in adj) { if (k2 !== "_row") a2[k2] = adj[k2]; }
      a2.Status = b.status;
      a2.DeclineReason = b.declineReason || "";
      updateRow("Adjustments", adj._row, a2);
      if (b.status === "APPROVED") {
        var ent = findRow("Entries", { Employee: b.employee, Date: b.date, Job: b.job, ClockIn: b.origIn });
        if (ent) {
          var e2 = {};
          for (var k3 in ent) { if (k3 !== "_row") e2[k3] = ent[k3]; }
          e2.ClockIn = b.reqIn; e2.ClockOut = b.reqOut; e2.Hours = b.reqHours;
          e2.AdjustmentApproved = "Yes";
          updateRow("Entries", ent._row, e2);
        } else {
          appendRow("Entries", {
            Date: b.date, Employee: b.employee, Job: b.job, ClockIn: b.reqIn, ClockOut: b.reqOut,
            Hours: b.reqHours, Training: "No", Issue: "", Refilled: "", LowItems: "",
            Stocked: "", Cloths: "", ChecklistDone: "", ChecklistItems: "",
            AdjustmentApproved: "Yes", Source: "adjustment-approved"
          });
        }
      }
      return { ok: true };
    }

    case "timeoff": {
      appendRow("TimeOff", {
        Date: b.date, Employee: b.name, Type: b.type, Reason: b.reason || "",
        Status: "PENDING", DeclineReason: "", Created: new Date().toISOString()
      });
      notify("Time off / sick request — " + b.name + " — " + b.date,
        "Raven & Roses — time off / sick request\n\nEmployee: " + b.name + "\nDate: " + b.date +
        "\nType: " + (b.type === "sick" ? "Sick day (paid, BC, up to 5/year)" : "Time off (unpaid)") +
        "\nReason: " + (b.reason || "—") + "\n\nApprove or decline it in the manager app.");
      return { ok: true };
    }

    case "decideTimeOff": {
      if (!isManager) return { ok: false, error: "Manager only." };
      var to = findRow("TimeOff", { Employee: b.employee, Date: b.date, Type: b.type });
      if (!to) return { ok: false, error: "Time-off request not found." };
      var t2 = {};
      for (var k4 in to) { if (k4 !== "_row") t2[k4] = to[k4]; }
      t2.Status = b.status;
      t2.DeclineReason = b.declineReason || "";
      updateRow("TimeOff", to._row, t2);
      return { ok: true };
    }

    case "mileage": {
      appendRow("Mileage", {
        Date: b.date, Employee: b.name, Start: b.start, End: b.end, Km: b.km, Type: "between"
      });
      return { ok: true };
    }

    case "mileageSubmit": {
      appendRow("MileageSubmissions", {
        Month: b.month, Employee: b.name,
        Trips: JSON.stringify(b.trips || []), TotalKm: b.totalKm,
        SubmittedAt: new Date().toISOString()
      });
      var lines = (b.trips || []).map(function (m) {
        return "- " + m.date + ": " + m.start + " → " + m.end + " — " + m.km + " km";
      }).join("\n");
      notify("Mileage submitted — " + b.name + " — " + b.month,
        "Raven & Roses — mileage submission\n\nEmployee: " + b.name + "\nMonth: " + b.month +
        "\nTrips: " + (b.trips || []).length + "\nTotal: " + b.totalKm + " km (between clients — payable)\n\n" + lines +
        "\n\nKm only — CRA rate is applied by Krystal in payroll.");
      return { ok: true };
    }

    case "monthlyTick": {
      if (b.done) {
        upsertRow("MonthlyDone",
          { Month: b.month, TaskId: b.taskId, Job: b.job },
          { Month: b.month, TaskId: b.taskId, Job: b.job, Employee: b.name, Date: b.date, DoneAt: new Date().toISOString() });
      } else {
        var md = findRow("MonthlyDone", { Month: b.month, TaskId: b.taskId, Job: b.job });
        if (md) sheet("MonthlyDone").deleteRow(md._row);
      }
      return { ok: true };
    }

    case "houseSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      upsertRow("HouseInstructions", { Client: b.client }, {
        Client: b.client, ServiceTag: b.serviceTag || "", ServiceNote: b.serviceNote || "",
        Tasks: b.tasks || "", Special: b.special || "", Codes: b.codes || ""
      });
      return { ok: true };
    }

    case "focusSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      upsertRow("MonthlyFocus", { Month: b.month }, {
        Month: b.month, Note: b.note || "",
        TasksJSON: JSON.stringify(b.tasks || []), RotationJSON: JSON.stringify(b.rotation || [])
      });
      return { ok: true };
    }

    case "scheduleSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      // Replace this employee's whole schedule: delete all their existing
      // rows first (bottom to top so row numbers stay valid), then append
      // one row per day they work. Other employees' rows are untouched.
      var rows = readTab("Schedule").filter(function (r) {
        return String(r.Employee || "").toLowerCase() === String(b.employee || "").toLowerCase();
      }).map(function (r) { return r._row; });
      rows.sort(function (a, c) { return c - a; });
      rows.forEach(function (rn) { sheet("Schedule").deleteRow(rn); });
      (b.schedule || []).forEach(function (s) {
        if (s.day && s.shift) appendRow("Schedule", { Employee: b.employee, Day: s.day, Shift: s.shift });
      });
      return { ok: true };
    }

    case "guideSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      var gsh = sheet("Guide");
      gsh.getRange(2, 1, Math.max(gsh.getLastRow() - 1, 1), 10).clearContent();
      var rows = [];
      (b.guide.rooms || []).forEach(function (room) {
        (room.items || []).forEach(function (it) {
          rows.push(["item", room.id, room.name, it.id, it.name, it.supply,
            (it.goodFor || []).join("; "), it.how || "", it.notes || "", it.tags || ""]);
        });
      });
      (b.guide.supplies || []).forEach(function (s) {
        rows.push(["supply", "", "", s.id, s.name, "", (s.goodFor || []).join("; "), s.how || "", s.notes || "", ""]);
      });
      if (rows.length) gsh.getRange(2, 1, rows.length, 10).setValues(rows);
      return { ok: true };
    }

    case "employeeSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      var em = findEmployee(b.employee);
      // Any code the manager sets is a FIRST-TIME (temporary) code: the
      // employee replaces it with their own 4-digit code on first sign-in.
      // Managers are exempt — Krystal's code is permanent.
      var isMgrRow = em && String(em.Role || "").toLowerCase() === "manager";
      if (!em) {
        appendRow("Employees", {
          Name: b.employee, Role: b.role || "Employee", Rate: b.rate === undefined ? "" : b.rate,
          Active: b.active === undefined ? "Yes" : (b.active ? "Yes" : "No"),
          Code: b.code === undefined ? "" : b.code,
          TempCode: (b.code && String(b.role || "Employee").toLowerCase() !== "manager") ? "Yes" : ""
        });
      } else {
        var em2 = {};
        for (var k5 in em) { if (k5 !== "_row") em2[k5] = em[k5]; }
        if (b.role !== undefined) em2.Role = b.role;
        if (b.rate !== undefined) em2.Rate = b.rate;
        if (b.active !== undefined) em2.Active = b.active ? "Yes" : "No";
        if (b.code !== undefined) {
          em2.Code = b.code;
          if (!isMgrRow) em2.TempCode = b.code ? "Yes" : "";
        }
        updateRow("Employees", em._row, em2);
      }
      if (b.rate !== undefined) {
        upsertRow("Rates", { Employee: b.employee }, { Employee: b.employee, Rate: b.rate });
      }
      return { ok: true };
    }

    case "ratesSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      upsertRow("Rates", { Employee: b.employee }, { Employee: b.employee, Rate: b.rate });
      var em3 = findEmployee(b.employee);
      if (em3) {
        var em4 = {};
        for (var k6 in em3) { if (k6 !== "_row") em4[k6] = em3[k6]; }
        em4.Rate = b.rate;
        updateRow("Employees", em3._row, em4);
      }
      return { ok: true };
    }

    case "settingsSave": {
      if (!isManager) return { ok: false, error: "Manager only." };
      if (b.managerCode !== undefined) upsertRow("Settings", { Key: "ManagerCode" }, { Key: "ManagerCode", Value: b.managerCode });
      if (b.craRate !== undefined) upsertRow("Settings", { Key: "CraRate" }, { Key: "CraRate", Value: b.craRate });
      if (b.td1Fed !== undefined) upsertRow("Settings", { Key: "TD1Fed" }, { Key: "TD1Fed", Value: b.td1Fed });
      if (b.td1Bc !== undefined) upsertRow("Settings", { Key: "TD1Bc" }, { Key: "TD1Bc", Value: b.td1Bc });
      if (b.businessNumber !== undefined) upsertRow("Settings", { Key: "BusinessNumber" }, { Key: "BusinessNumber", Value: b.businessNumber });
      if (b.rpAccount !== undefined) upsertRow("Settings", { Key: "RpAccount" }, { Key: "RpAccount", Value: b.rpAccount });
      return { ok: true };
    }

    case "emailPaystubs": {
      // One tap per payday: email each employee ONLY their own paystub.
      // Body: {periodStart, periodEnd, payDate, stubs:[{employee, email, text}]}.
      // The payroll app builds each stub from that employee's own saved run,
      // so no other employee's data is ever in an email. Each send is
      // recorded in the PaystubSends tab (who, which period, when) so the
      // same period is not sent twice by accident. No SIN is ever in a
      // paystub or email.
      if (!isManager) return { ok: false, error: "Manager only." };
      var sent = [], skipped = [];
      (b.stubs || []).forEach(function (s) {
        var email = String(s.email || "").trim();
        if (!email || email.indexOf("@") < 0) { skipped.push({ employee: s.employee, reason: "No email on file" }); return; }
        var subject = "Your Raven & Roses paystub — " + (b.periodStart || "") + " to " + (b.periodEnd || "");
        try {
          MailApp.sendEmail(email, subject, String(s.text || ""));
          appendRow("PaystubSends", {
            PeriodStart: b.periodStart || "", PeriodEnd: b.periodEnd || "", PayDate: b.payDate || "",
            Employee: s.employee, Email: email, SentAt: new Date().toISOString()
          });
          sent.push(s.employee);
        } catch (err2) {
          skipped.push({ employee: s.employee, reason: "Email failed: " + err2 });
        }
      });
      return { ok: true, sent: sent, skipped: skipped };
    }

    case "remittanceSave": {
      // Mark a month as remitted: {month, dueDate, remitTotal, paidDate,
      // confirmation, paidAmount}. One row per month (upsert by Month).
      if (!isManager) return { ok: false, error: "Manager only." };
      upsertRow("Remittances", { Month: b.month }, {
        Month: b.month, DueDate: b.dueDate || "", RemitTotal: b.remitTotal || "",
        PaidDate: b.paidDate || "", Confirmation: b.confirmation || "", PaidAmount: b.paidAmount || ""
      });
      return { ok: true };
    }

    case "copyAlert": {
      // A detectable copy attempt in the employee app. The app throttles
      // this to once per login session so Krystal's inbox is not spammed.
      notify("Copy attempt in employee app — " + b.name,
        "Raven & Roses — copy attempt\n\nEmployee: " + b.name +
        "\nWhere: " + (b.where || "client information") +
        "\nWhen: " + new Date().toISOString() +
        "\n\nThis was a detectable copy / long-press attempt in the app. " +
        "OS screenshots cannot be detected by a web app — see the watermark " +
        "and the native-wrapper note in the employee app if this keeps happening.");
      return { ok: true };
    }
  }
  return { ok: false, error: "Unknown action: " + action };
}

function fmtTime(ms) {
  if (!ms) return "—";
  var d = new Date(Number(ms));
  var h = d.getHours(), m = d.getMinutes();
  var ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + (m < 10 ? "0" : "") + m + " " + ap;
}
