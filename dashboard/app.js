const labels = { pending: "Pendiente", applied: "Enviada", interviewing: "Entrevista", offer: "Oferta",
  rejected: "Rechazada", closed: "Cerrada", skipped: "Descartada" };
const approvalLabels = { no_review: "Falta revisión", awaiting_approval: "Por aprobar", approved: "Autorizada",
  declined: "No autorizada", revoked: "Autorización retirada", claimed: "Autorización utilizada" };
const state = { rows: [], csrf: "", selected: null, view: "all" };
const $ = (id) => document.getElementById(id);

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = String(value);
  return element;
}

function notice(message, error = false) {
  const box = $("notice");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = !message;
}

async function request(route, payload) {
  const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
    body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "No se pudo guardar el cambio");
  return result;
}

function counts() {
  const c = Object.fromEntries(Object.keys(labels).map((key) => [key, 0]));
  for (const row of state.rows) c[row.status] = (c[row.status] || 0) + 1;
  return c;
}

function inView(row) {
  if (state.view === "review") return row.status === "pending" && row.approval !== "claimed";
  if (state.view === "active") return ["applied", "interviewing", "offer"].includes(row.status);
  if (state.view === "closed") return ["rejected", "closed", "skipped"].includes(row.status);
  return true;
}

function visibleRows() {
  const query = $("search").value.trim().toLocaleLowerCase();
  const filter = $("status-filter").value;
  return state.rows.filter((row) => inView(row) && (filter === "all" || row.status === filter) &&
    `${row.company} ${row.role} ${row.source}`.toLocaleLowerCase().includes(query));
}

function renderOverview() {
  const c = counts();
  const review = state.rows.filter((r) => r.status === "pending" && r.approval !== "claimed").length;
  $("metric-review").textContent = review;
  $("metric-applied").textContent = c.applied + c.interviewing + c.offer + c.rejected + c.closed;
  $("metric-interviewing").textContent = c.interviewing;
  $("metric-offer").textContent = c.offer;
  $("nav-all").textContent = state.rows.length;
  $("nav-review").textContent = review;
  $("nav-active").textContent = c.applied + c.interviewing + c.offer;
  $("nav-closed").textContent = c.rejected + c.closed + c.skipped;
  const track = $("stage-track");
  track.replaceChildren();
  for (const key of ["pending", "applied", "interviewing", "offer", "rejected", "closed"]) {
    const item = node("div", `stage ${key}`);
    item.append(node("span", "", labels[key]), node("b", "", c[key]));
    track.append(item);
  }
}

function renderList() {
  const rows = visibleRows();
  $("result-count").textContent = `${rows.length} candidatura${rows.length === 1 ? "" : "s"}`;
  const list = $("application-list");
  list.replaceChildren();
  if (!rows.length) {
    list.append(node("p", "empty-list", state.rows.length ? "No hay candidaturas con este filtro." :
      "Todavía no hay candidaturas. Ejecuta /seekter-init y luego /seekter-run en Claude Code."));
    return;
  }
  for (const row of rows) {
    const button = node("button", `row ${row.status}${row.id === state.selected ? " selected" : ""}`);
    button.type = "button";
    button.setAttribute("aria-label", `${row.company}, ${row.role}, ${labels[row.status] || row.status}`);
    button.append(node("span", "row-bar"));
    const content = node("span", "row-content");
    const top = node("span", "row-top");
    top.append(node("span", "row-company", row.company || "Sin empresa"), node("span", "row-date", row.applied || row.updated));
    content.append(top, node("span", "row-role", row.role || "Sin puesto"));
    const meta = node("span", "row-meta");
    meta.append(node("span", `badge ${row.status}`, labels[row.status] || row.status));
    if (row.status === "pending") meta.append(node("span", `badge ${row.approval === "approved" ? "approved" : row.approval === "declined" ? "declined" : ""}`, approvalLabels[row.approval] || "Por revisar"));
    if (row.source) meta.append(node("span", "source", row.source));
    content.append(meta);
    button.append(content);
    button.addEventListener("click", () => { state.selected = row.id; renderList(); renderDetail(); });
    list.append(button);
  }
}

function detailSection(parent, title, text) {
  if (!text) return;
  const section = node("section", "detail-section");
  section.append(node("h3", "", title), node("p", "", text));
  parent.append(section);
}

function pairList(parent, title, items) {
  if (!items?.length) return;
  const section = node("section", "detail-section");
  section.append(node("h3", "", title));
  const grid = node("div", "review-grid");
  for (const item of items) {
    const row = node("div", "review-item");
    row.append(node("span", "", item.label), node("strong", "", item.value));
    grid.append(row);
  }
  section.append(grid);
  parent.append(section);
}

function approvalControls(parent, row) {
  const review = row.review;
  if (!review) {
    parent.append(node("p", "review-note", "El agente aún no ha preparado una revisión completa. No se puede autorizar el envío desde aquí."));
    return;
  }
  const intro = node("div", "review-note", row.approval === "approved" ?
    "Autorizada. Vuelve a Claude Code y escribe «continúa» para que compruebe y use esta aprobación." :
    row.approval === "claimed" ? "La aprobación ya se utilizó. Un reintento requiere una revisión nueva." :
    "Revisa todos los datos antes de autorizar. Este botón no envía nada al empleador.");
  parent.append(intro);
  const cvSection = node("section", "detail-section");
  cvSection.append(node("h3", "", "CV seleccionado"), node("p", "", review.cv));
  const cvLink = node("a", "detail-link", "Abrir PDF del CV");
  cvLink.href = `/api/cv/${row.id}`;
  cvLink.target = "_blank";
  cvLink.rel = "noopener noreferrer";
  cvSection.append(cvLink);
  parent.append(cvSection);
  pairList(parent, "Datos y respuestas del formulario", review.fields);
  pairList(parent, "Respuestas de texto", review.answers);
  pairList(parent, "Consentimientos y declaraciones", review.consents);
  detailSection(parent, "Observaciones de la revisión", review.notes);
  const controls = node("div", "review-actions");
  if (row.approval !== "claimed") {
    if (row.approval !== "approved") {
      const approve = node("button", "primary", "Autorizar este envío");
      approve.type = "button";
      approve.addEventListener("click", async () => {
        if (!window.confirm(`¿Autorizar un intento de envío para ${row.role} en ${row.company}?`)) return;
        try { await request("/api/decision", { id: row.id, decision: "approved" }); await load(`Envío autorizado para ${row.company}. Vuelve a Claude Code y escribe «continúa».`); }
        catch (error) { notice(error.message, true); }
      });
      controls.append(approve);
    }
    const other = node("button", row.approval === "approved" ? "danger" : "secondary", row.approval === "approved" ? "Retirar autorización" : "No autorizar");
    other.type = "button";
    other.addEventListener("click", async () => {
      try { await request("/api/decision", { id: row.id, decision: row.approval === "approved" ? "revoked" : "declined" }); await load("Decisión guardada. No se enviará esta candidatura sin una nueva aprobación."); }
      catch (error) { notice(error.message, true); }
    });
    controls.append(other);
  }
  parent.append(controls, node("p", "action-help", "La autorización vale para esta revisión y un solo intento. Si cambian las respuestas o el CV, hay que revisar de nuevo."));
}

function stageControls(parent, row) {
  if (row.status === "skipped") return;
  const section = node("section", "detail-section");
  section.append(node("h3", "", "Actualizar etapa"));
  const form = node("form", "stage-form");
  const select = node("select");
  select.setAttribute("aria-label", "Nueva etapa");
  for (const key of ["pending", "applied", "interviewing", "offer", "rejected", "closed"]) {
    const option = node("option", "", labels[key]); option.value = key; option.selected = key === row.status; select.append(option);
  }
  const save = node("button", "secondary", "Guardar etapa"); save.type = "submit";
  const note = node("input"); note.type = "text"; note.placeholder = "Nota de seguimiento (requerida para registrar un envío)"; note.maxLength = 300;
  form.append(select, save, note);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await request("/api/stage", { id: row.id, status: select.value, note: note.value }); await load("Etapa actualizada en el tracker."); }
    catch (error) { notice(error.message, true); }
  });
  section.append(form, node("p", "action-help", "Cambiar la etapa solo actualiza el CRM; no envía formularios ni mensajes."));
  parent.append(section);
}

function renderDetail() {
  const row = state.rows.find((item) => item.id === state.selected);
  const panel = $("application-detail");
  panel.replaceChildren();
  if (!row) {
    const empty = node("div", "detail-empty");
    empty.append(node("div", "empty-glyph", "↗"), node("h2", "", "Elige una candidatura"), node("p", "", "Verás sus datos, la revisión del envío y los próximos pasos."));
    panel.append(empty); return;
  }
  const heading = node("div", "detail-head");
  heading.append(node("h2", "", row.role || "Sin puesto"));
  panel.append(heading, node("p", "detail-company", row.company || "Sin empresa"));
  panel.append(node("p", "detail-status", `${labels[row.status] || row.status}${row.status === "pending" ? ` · ${approvalLabels[row.approval] || "Por revisar"}` : ""}`));
  if (/^https?:\/\//i.test(row.url)) {
    const link = node("a", "detail-link", "Abrir oferta original"); link.href = row.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    panel.append(link);
  }
  const summary = [row.fit ? `Ajuste: ${row.fit}/5` : "", row.source ? `Fuente: ${row.source}` : "", row.location ? `Ubicación: ${row.location}` : ""].filter(Boolean).join(" · ");
  detailSection(panel, "Datos", summary);
  detailSection(panel, "Por qué encaja", row.why);
  detailSection(panel, "Notas", row.notes);
  if (row.status === "pending") approvalControls(panel, row);
  else detailSection(panel, "Respuestas registradas", row.answers);
  stageControls(panel, row);
}

async function load(message = "") {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo leer el tracker");
    const data = await response.json();
    state.rows = data.rows;
    state.csrf = data.csrf;
    if (!state.rows.some((row) => row.id === state.selected)) state.selected = state.rows.find((row) => row.status === "pending")?.id || state.rows[0]?.id || null;
    $("updated-at").textContent = `Actualizado ${new Date(data.generatedAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`;
    renderOverview(); renderList(); renderDetail(); notice(message);
  } catch (error) { notice(error.message, true); }
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  state.view = button.dataset.view;
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
  renderList();
}));
$("search").addEventListener("input", renderList);
$("status-filter").addEventListener("change", renderList);
$("refresh").addEventListener("click", () => load("Datos actualizados."));
load();
