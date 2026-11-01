// Attendance sync server for the tuition portals demo.
// Plain Node (no dependencies). Runs on port 4000.
// Holds the shared OTP + attendance state that the teacher and
// student portals (separate apps, separate storage) both talk to.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4000;
const OTP_TTL_MS = 3 * 60 * 1000; // OTP is valid for 3 minutes (covers read-aloud + typing)

// Batch-name -> batch-id mapping (must match the portals' demoData)
const BATCH_NAME_TO_ID = { "Morning": 1, "Evening": 2 };

const DB_FILE = path.join(__dirname, "data", "db.json");
const SAVE_DEBOUNCE_MS = 150;
let saveTimer = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = {
      students,
      records,
      announcements,
      assignments,
      timetable,
      sessions: [...sessions.entries()],
      usedOtpKeys: [...usedOtpKeys],
      activeOtps: [...activeOtps.entries()],
    };
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error("db save failed:", err.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

/** @type {Map<string, {code:string, batchId:number, createdAt:number, expiresAt:number}>} */
const activeOtps = new Map(); // key: `${batchId}:${code}`
/** @type {Set<string>} */
const usedOtpKeys = new Set(); // key: `${batchId}:${date}:${code}:${studentId}`
/** @type {Map<string, {batchId:number, date:string, source:string}>} */
const sessions = new Map(); // key: `${batchId}:${date}`, source: 'otp' | 'manual'
/** @type {{id:number,name:string,nameTa:string,roll:string,batch:string,batchId:number|null,contact:string,email:string}[]} */
let students = [];

/** @type {{batchId:number,studentId:number,studentName:string,date:string,status:string,method:string,ts:string}[]} */
let records = [];

/** @type {{id:number,title:string,titleTa:string,body:string,bodyTa:string,date:string}[]} */
let announcements = [];

/** @type {{id:number,batchId:number,day:number,subject:string,start:string,end:string,mode:string,teacher:string}[]} */
let timetable = [];

/** @type {{id:number,title:string,titleTa:string,subject:string,subjectTa:string,batch:string,batchId:number|null,dueDate:string,maxMarks:number,submissions:{studentId:number,studentName:string,note:string,submittedOn:string,marks:number|null,feedback:string|null}[]}[]} */
let assignments = [];

// Restore state saved by a previous run (students, attendance records,
// sessions, OTP bookkeeping). Missing/corrupt file = fresh demo state.
(function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (Array.isArray(db.students) && db.students.length) students = db.students;
    if (Array.isArray(db.records)) records = db.records;
    if (Array.isArray(db.announcements)) announcements = db.announcements;
    if (Array.isArray(db.assignments)) assignments = db.assignments;
    if (Array.isArray(db.timetable)) timetable = db.timetable;
    if (Array.isArray(db.sessions)) for (const [k, v] of db.sessions) sessions.set(k, v);
    if (Array.isArray(db.usedOtpKeys)) for (const k of db.usedOtpKeys) usedOtpKeys.add(k);
    if (Array.isArray(db.activeOtps)) for (const [k, v] of db.activeOtps) activeOtps.set(k, v);
    purgeExpiredOtps();
  } catch {
    /* no saved state yet */
  }
})();

function today() {
  // Local calendar date (server timezone), NOT UTC — toISOString shifted the
  // attendance day whenever this machine ran past local midnight.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function purgeExpiredOtps() {
  const now = Date.now();
  for (const [key, otp] of activeOtps) {
    if (otp.expiresAt <= now) activeOtps.delete(key);
  }
}

function ensureSession(batchId, date, source) {
  const key = `${batchId}:${date}`;
  const existing = sessions.get(key);
  if (existing) {
    if (source === "manual") existing.source = "manual";
    return existing;
  }
  const session = { batchId, date, source };
  sessions.set(key, session);
  return session;
}

function generateOtp(batchId) {
  if (!batchId) return { error: "batchId required" };
  purgeExpiredOtps();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = Date.now();
  activeOtps.set(`${batchId}:${code}`, {
    code, batchId: Number(batchId), createdAt: now, expiresAt: now + OTP_TTL_MS,
  });
  ensureSession(Number(batchId), today(), "otp");
  persist();
  return { batchId: Number(batchId), code, expiresAt: now + OTP_TTL_MS, ttlMs: OTP_TTL_MS };
}

// Single-use per student: each student may mark attendance once per code,
// and only once per batch per day (OTP + manual exclude each other per day).
function verifyOtp({ batchId, studentId, studentName, code }) {
  if (!batchId || !code || !studentId) return { error: "batchId, studentId and code are required" };
  const date = today();
  // Look up the OTP by code (batch-agnostic) so a code generated by the
  // teacher for any batch verifies correctly in the student portal.
  let otp = activeOtps.get(`${batchId}:${code}`);
  if (!otp) {
    for (const o of activeOtps.values()) {
      if (o.code === code) { otp = o; break; }
    }
  }
  if (!otp) return { error: "wrong_code" };
  // Use the batch the OTP was actually generated for.
  batchId = otp.batchId;
  if (otp.expiresAt <= Date.now()) {
    activeOtps.delete(`${batchId}:${code}`);
    return { error: "expired" };
  }
  purgeExpiredOtps();
  if (usedOtpKeys.has(`${batchId}:${date}:${code}:${studentId}`)) {
    return { error: "already_used" };
  }
  const existing = records.find(
    (r) => r.batchId === Number(batchId) && r.studentId === Number(studentId) && r.date === date
  );
  if (existing && existing.method === "otp") {
    return { error: "already_marked" };
  }
  if (existing && existing.method === "manual") {
    // Student-verified physical presence outranks the teacher's default or
    // unsaved manual mark: drop the manual row so the OTP-present stands.
    records = records.filter(
      (r) =>
        !(
          r.batchId === Number(batchId) &&
          r.studentId === Number(studentId) &&
          r.date === date &&
          r.method === "manual"
        )
    );
  }

  records.push({
    batchId: Number(batchId),
    studentId: Number(studentId),
    studentName: studentName || "",
    date,
    status: "present",
    method: "otp",
    ts: new Date().toISOString(),
  });
  usedOtpKeys.add(`${batchId}:${date}:${code}:${studentId}`);
  ensureSession(Number(batchId), date, "otp");
  persist();
  return { ok: true, date, status: "present", code };
}

// Teacher manual marks: replace the manual rows for that batch+date,
// keep OTP rows untouched so student-verified attendance is never overwritten.
function saveManual({ batchId, date, marks }) {
  if (!batchId || !date || !marks || typeof marks !== "object") {
    return { error: "batchId, date and marks object are required" };
  }
  records = records.filter(
    (r) => !(r.batchId === Number(batchId) && r.date === date && r.method === "manual")
  );
  for (const [studentId, status] of Object.entries(marks)) {
    records.push({
      batchId: Number(batchId),
      studentId: Number(studentId),
      studentName: "",
      date,
      status: status === "absent" ? "absent" : "present",
      method: "manual",
      ts: new Date().toISOString(),
    });
  }
  ensureSession(Number(batchId), date, "manual");
  persist();
  const list = records.filter((r) => r.batchId === Number(batchId) && r.date === date);
  return { ok: true, saved: list.length, date };
}

// ---- Announcements (teacher -> all students/parents) ----

function listAnnouncements() {
  return { announcements: [...announcements].sort((a, b) => (a.id < b.id ? 1 : -1)) };
}

function createAnnouncement({ title, body }) {
  if (!title || !body) return { error: "title and body are required" };
  const item = {
    id: Date.now(),
    title: String(title),
    titleTa: String(title),
    body: String(body),
    bodyTa: String(body),
    date: today(),
  };
  announcements.push(item);
  persist();
  return { ok: true, announcement: item };
}

// ---- Assignments (teacher creates per batch; students submit; teacher grades) ----

// Derived per-assignment status: pending (no submissions) -> submitted
// (any ungraded submission) -> graded (all submissions graded).
function assignmentStatus(a) {
  if (!a.submissions.length) return "pending";
  return a.submissions.every((s) => s.marks != null) ? "graded" : "submitted";
}

function listAssignments(batchId) {
  const rows = (batchId ? assignments.filter((a) => a.batchId === Number(batchId)) : assignments)
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map((a) => ({ ...a, status: assignmentStatus(a) }));
  return { assignments: rows };
}

function createAssignment({ title, batch, batchId, dueDate, maxMarks }) {
  if (!title || !batch) return { error: "title and batch are required" };
  const item = {
    id: Date.now(),
    title: String(title),
    titleTa: String(title),
    subject: "Mathematics",
    subjectTa: "கணிதம்",
    batch: String(batch),
    batchId: Number(batchId) || BATCH_NAME_TO_ID[String(batch)] || null,
    dueDate: dueDate ? String(dueDate) : today(),
    maxMarks: Number(maxMarks) || 20,
    submissions: [],
  };
  assignments.push(item);
  persist();
  return { ok: true, assignment: { ...item, status: "pending" } };
}

function findAssignment(id) {
  return assignments.find((a) => a.id === Number(id));
}

function submitAssignment({ id, studentId, studentName, note }) {
  const a = findAssignment(id);
  if (!a) return { error: "assignment_not_found" };
  if (!studentId) return { error: "studentId required" };
  let sub = a.submissions.find((s) => s.studentId === Number(studentId));
  if (!sub) {
    sub = { studentId: Number(studentId), studentName: studentName || "", note: "", submittedOn: today(), marks: null, feedback: null };
    a.submissions.push(sub);
  }
  sub.note = note == null ? sub.note : String(note);
  persist();
  return { ok: true, assignmentId: a.id, submission: sub };
}

function gradeAssignment({ id, studentId, marks, feedback }) {
  const a = findAssignment(id);
  if (!a) return { error: "assignment_not_found" };
  const sub = a.submissions.find((s) => s.studentId === Number(studentId));
  if (!sub) return { error: "submission_not_found" };
  sub.marks = marks == null ? sub.marks : Number(marks);
  sub.feedback = feedback == null ? sub.feedback : String(feedback);
  persist();
  return { ok: true, assignmentId: a.id, submission: sub, status: assignmentStatus(a) };
}

// ---- Timetable (teacher builds the weekly class schedule per batch) ----

function listTimetable(batchId) {
  const rows = timetable
    .filter((c) => (batchId ? c.batchId === Number(batchId) : true))
    .slice()
    .sort((a, b) => a.day - b.day || (a.start < b.start ? -1 : 1));
  return { timetable: rows };
}

function saveTimetableClass({ id, batchId, day, subject, start, end, mode, teacher }) {
  const batch = Number(batchId);
  const dayNum = Math.min(6, Math.max(0, Number(day) || 0));
  if (!batch) return { error: "batchId required" };
  if (!subject || !subject.trim()) return { error: "subject required" };
  if (!start || !end) return { error: "start and end required" };
  const item = {
    id: id ? Number(id) : Date.now(),
    batchId: batch,
    day: dayNum,
    subject: String(subject).trim(),
    start: String(start),
    end: String(end),
    mode: mode === "online" ? "online" : "offline",
    teacher: teacher ? String(teacher) : "",
  };
  const existing = timetable.findIndex((c) => c.id === item.id);
  if (existing >= 0) timetable[existing] = item;
  else timetable.push(item);
  persist();
  return { ok: true, entry: item };
}

function removeTimetableClass(id) {
  const before = timetable.length;
  timetable = timetable.filter((c) => c.id !== Number(id));
  if (timetable.length === before) return { error: "not_found" };
  persist();
  return { ok: true };
}

function listForStudent(batchId, studentId) {
  const rows = [];
  const sessionList = [...sessions.values()]
    .filter((s) => s.batchId === Number(batchId))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const session of sessionList) {
    const rec =
      records.find((r) => r.batchId === Number(batchId) && r.studentId === Number(studentId) && r.date === session.date);
    rows.push({
      date: session.date,
      source: session.source,
      status: rec ? rec.status : "absent",
      method: rec ? rec.method : null,
      ts: rec ? rec.ts : null,
    });
  }
  const present = rows.filter((r) => r.status === "present").length;
  const pct = rows.length ? Math.round((present / rows.length) * 100) : 0;
  return { batchId: Number(batchId), studentId: Number(studentId), sessions: rows, present, absent: rows.length - present, total: rows.length, pct };
}

function marksForDate(batchId, date) {
  // Per student the NEWEST record wins, so a later OTP verification
  // correctly overrides an earlier manual mark for the same date.
  const marks = {};
  const methods = {};
  const byStudent = new Map();
  for (const r of records) {
    if (r.batchId !== Number(batchId) || r.date !== date) continue;
    if (!byStudent.has(r.studentId) || (r.ts || "") > byStudent.get(r.studentId).ts) {
      byStudent.set(r.studentId, r);
    }
  }
  for (const r of byStudent.values()) {
    marks[r.studentId] = r.status;
    methods[r.studentId] = r.method;
  }
  return { batchId: Number(batchId), date, marks, methods };
}

function sessionsForBatch(batchId) {
  const rows = [...sessions.values()]
    .filter((s) => s.batchId === Number(batchId))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((s) => {
      const batchRecords = records.filter((r) => r.batchId === s.batchId && r.date === s.date);
      const present = batchRecords.filter((r) => r.status === "present").length;
      // Unmarked roster students in a saved session count as absent, so the
      // session summary agrees with how the student portal treats them.
      const batchRoster = students.filter((st) => (st.batchId ?? BATCH_NAME_TO_ID[st.batch] ?? null) === s.batchId).length;
      const absent = Math.max(batchRoster - present, batchRecords.filter((r) => r.status === "absent").length);
      return {
        date: s.date,
        source: s.source,
        present,
        absent,
        otpVerified: batchRecords.filter((r) => r.method === "otp").length,
      };
    });
  return { batchId: Number(batchId), sessions: rows };
}

// Real attendance percentage per student, computed from sessions + records
// for the student's own batch (mirrors listForStudent's math).
function attendancePctFor(student) {
  const batchId =
    student.batchId ??
    (student.batch && BATCH_NAME_TO_ID[student.batch]) ??
    null;
  if (batchId == null) return null;
  const sessionList = [...sessions.values()].filter((s) => s.batchId === Number(batchId));
  if (!sessionList.length) return 0;
  const present = sessionList.filter((s) => {
    const rec = records.find(
      (r) => r.batchId === Number(batchId) && r.studentId === Number(student.id) && r.date === s.date
    );
    return rec && rec.status === "present";
  }).length;
  return Math.round((present / sessionList.length) * 100);
}

function studentsWithStats() {
  return students.map((s) => ({ ...s, attendancePct: attendancePctFor(s) }));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  try {
    if (path === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "attendance-server", otpTtlMs: OTP_TTL_MS });
    }

    if (path === "/api/otp/generate" && req.method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, generateOtp(body.batchId));
    }

    if (path === "/api/otp/verify" && req.method === "POST") {
      const body = await readBody(req);
      const result = verifyOtp(body);
      return sendJson(res, result.error ? 400 : 200, result);
    }

    if (path === "/api/attendance/manual" && req.method === "POST") {
      const body = await readBody(req);
      const result = saveManual(body);
      return sendJson(res, result.error ? 400 : 200, result);
    }

    if (path === "/api/attendance") {
      const batchId = url.searchParams.get("batchId");
      const studentId = url.searchParams.get("studentId");
      const date = url.searchParams.get("date");
      if (studentId) {
        return sendJson(res, 200, listForStudent(batchId, studentId));
      }
      if (date) {
        return sendJson(res, 200, marksForDate(batchId, date));
      }
      return sendJson(res, 200, sessionsForBatch(batchId));
    }

    if (path === "/api/students" && req.method === "GET") {
      return sendJson(res, 200, studentsWithStats());
    }
    if (path === "/api/students" && req.method === "POST") {
      const body = await readBody(req);
      // Students can only log into the student portal with an email the
      // teacher registered, so it is mandatory and must look like an email.
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, {
          error: "email_required",
          message: "A valid email is required for the student to log in",
        });
      }
      const batchName = body.batch || "Morning";
      const batchId =
        Number(body.batchId) ||
        BATCH_NAME_TO_ID[batchName] ||
        null;
      const s = {
        // First-ever student occupies id 1 — the shared "demo child" id the
        // student/parent portals verify and read with.
        id: students.length === 0 ? 1 : Date.now(),
        name: body.name || "",
        nameTa: body.name || "",
        roll: body.roll || `S${students.length + 1}`,
        batch: batchName,
        batchId,
        contact: body.contact || "",
        email,
      };
      students.push(s);
      persist();
      return sendJson(res, 200, { ...s, attendancePct: attendancePctFor(s) });
    }
    if (path.startsWith("/api/students/") && req.method === "DELETE") {
      const id = Number(path.split("/").pop());
      students = students.filter((s) => s.id !== id);
      persist();
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/api/announcements" && req.method === "GET") {
      return sendJson(res, 200, listAnnouncements());
    }
    if (path === "/api/announcements" && req.method === "POST") {
      const body = await readBody(req);
      const result = createAnnouncement(body);
      return sendJson(res, result.error ? 400 : 200, result);
    }
    if (path === "/api/assignments" && req.method === "GET") {
      const batchId = url.searchParams.get("batchId");
      return sendJson(res, 200, listAssignments(batchId));
    }
    if (path === "/api/assignments" && req.method === "POST") {
      const body = await readBody(req);
      const result = createAssignment(body);
      return sendJson(res, result.error ? 400 : 200, result);
    }
    const submitMatch = path.match(/^\/api\/assignments\/(\d+)\/submit$/);
    if (submitMatch && req.method === "POST") {
      const body = await readBody(req);
      const result = submitAssignment({ ...body, id: submitMatch[1] });
      return sendJson(res, result.error ? 404 : 200, result);
    }
    const gradeMatch = path.match(/^\/api\/assignments\/(\d+)\/grade$/);
    if (gradeMatch && req.method === "POST") {
      const body = await readBody(req);
      const result = gradeAssignment({ ...body, id: gradeMatch[1] });
      return sendJson(res, result.error ? 404 : 200, result);
    }
    if (path === "/api/timetable" && req.method === "GET") {
      const batchId = url.searchParams.get("batchId");
      return sendJson(res, 200, listTimetable(batchId));
    }
    if (path === "/api/timetable" && req.method === "POST") {
      const body = await readBody(req);
      const result = saveTimetableClass(body);
      return sendJson(res, result.error ? 400 : 200, result);
    }
    const timetableDel = path.match(/^\/api\/timetable\/(\d+)$/);
    if (timetableDel && req.method === "DELETE") {
      const result = removeTimetableClass(Number(timetableDel[1]));
      return sendJson(res, result.error ? 404 : 200, result);
    }
    if (path === "/admin/reset" && req.method === "POST") {
      activeOtps.clear();
      usedOtpKeys.clear();
      sessions.clear();
      records = [];
      announcements = [];
      assignments = [];
      timetable = [];
      persist();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    return sendJson(res, 500, { error: "server_error", message: String(err && err.message) });
  }
});

server.listen(PORT, () => {
  console.log(`attendance-server listening on http://localhost:${PORT} (OTP valid ${OTP_TTL_MS / 1000}s)`);
});
