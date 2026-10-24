// No user value is interpreted as HTML, CSS, code, a URL or a DOM attribute name.
export function sanitizeMarkdown(source) {
  return String(source).slice(0, 262144).replace(/\u0000/g, "").replace(/<(script|style|iframe|object|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<[^>]*>/g, "");
}

export function evaluateExpression(expression, inputs = {}) {
  if (typeof expression !== "string" || expression.length > 512) throw new Error("Expression is too long");
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+*/%\-]|\S/gi) || [];
  if (tokens.length > 128) throw new Error("Too many terms");
  let at = 0;
  function atom(depth) {
    if (depth > 32) throw new Error("Expression is too deep");
    const t = tokens[at++];
    if (t === "+" || t === "-") return (t === "-" ? -1 : 1) * atom(depth + 1);
    if (t === "(") { const n = sum(depth + 1); if (tokens[at++] !== ")") throw new Error("Missing parenthesis"); return n; }
    if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(t || "")) return Number(t);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t || "") && Object.hasOwn(inputs, t) && typeof inputs[t] === "number") return inputs[t];
    throw new Error("Unknown input or invalid expression");
  }
  function product(depth) {
    let n = atom(depth);
    while (["*", "/", "%"].includes(tokens[at])) { const op = tokens[at++], rhs = atom(depth); n = op === "*" ? n * rhs : op === "/" ? n / rhs : n % rhs; }
    return n;
  }
  function sum(depth) {
    let n = product(depth);
    while (["+", "-"].includes(tokens[at])) { const op = tokens[at++], rhs = product(depth); n = op === "+" ? n + rhs : n - rhs; }
    return n;
  }
  const n = sum(0);
  if (at !== tokens.length || !Number.isFinite(n)) throw new Error("Invalid or non-finite result");
  return n;
}

export function parsePage(source) {
  // Only JSON inside an exact `page` fence is a component. Everything else is text.
  const pieces = String(source).slice(0, 262144).split(/```page\s*\n([\s\S]*?)\n```/g);
  return pieces.slice(0, 401).map((piece, i) => {
    if (i % 2 === 0) return { type: "markdown", text: sanitizeMarkdown(piece) };
    try { const v = JSON.parse(piece); return v && typeof v === "object" && !Array.isArray(v) ? v : { type: "invalid" }; }
    catch { return { type: "invalid" }; }
  });
}

export function runRenderer() {
  const root = document.getElementById("page");
  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = String(text).slice(0, 20000);
    if (cls) n.className = cls;
    return n;
  }
  function inline(n, text) {
    // Links and images intentionally remain inert labels. No user URL is assigned anywhere.
    text = String(text).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g)) {
      if (part.startsWith("**") && part.endsWith("**")) n.append(el("strong", part.slice(2, -2)));
      else if (part.startsWith("`") && part.endsWith("`")) n.append(el("code", part.slice(1, -1)));
      else if (part.startsWith("*") && part.endsWith("*")) n.append(el("em", part.slice(1, -1)));
      else n.append(document.createTextNode(part));
    }
  }
  let values, calculators, count;
  function refresh() {
    calculators.forEach(({ output, expression }) => {
      try { output.textContent = String(Number(evaluateExpression(expression, values).toFixed(6))); }
      catch (e) { output.textContent = "Check inputs"; }
    });
  }
  function markdown(target, text) {
    let tableLines = [];
    function flush() {
      if (tableLines.length > 1) {
        const rows = tableLines.map(line => line.replace(/^\||\|$/g, "").split("|").map(cell => cell.trim()));
        component(target, { type: "table", columns: rows[0], rows: rows.slice(1).filter(row => !row.every(cell => /^:?-+:?$/.test(cell))) }, 0);
      } else if (tableLines.length) inline(target.appendChild(el("p")), tableLines[0]);
      tableLines = [];
    }
    for (const line of text.split("\n").slice(0, 6000)) {
      if (line.trim().startsWith("|") && line.trim().endsWith("|")) { tableLines.push(line.trim()); continue; }
      flush(); if (!line.trim()) continue;
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const check = /^[-*] \[([ xX])\] (.*)$/.exec(line);
      if (check) { const label = el("label", null, "check"); const box = el("input"); box.type = "checkbox"; box.checked = check[1] !== " "; label.append(box, el("span", check[2])); target.append(label); }
      else { const n = el(heading ? "h" + heading[1].length : "p"); inline(n, heading ? heading[2] : line); target.append(n); }
    }
    flush();
  }
  function component(target, item, depth) {
    if (++count > 200 || depth > 4 || !item || typeof item !== "object") return;
    const section = el("section", null, "block"); target.append(section);
    if (item.title) section.append(el("h3", item.title));
    switch (item.type) {
      case "markdown": markdown(section, sanitizeMarkdown(item.text || "")); break;
      case "table": case "grid": {
        const columns = Array.isArray(item.columns) ? item.columns.slice(0, 30).map(String) : [];
        const rows = Array.isArray(item.rows) ? item.rows.slice(0, 1000).filter(Array.isArray).map(row => columns.map((_, i) => String(row[i] ?? "").slice(0, 2000))) : [];
        const table = el("table"), head = el("thead"), tr = el("tr"), body = el("tbody"); let sort = -1, ascending = true, hasSorted = false, query = "";
        columns.forEach((column, i) => { const th = el("th"); th.scope = "col"; th.setAttribute("role", "columnheader");
          if (item.type === "grid") { const b = el("button", column + " ↕"); b.type = "button"; th.setAttribute("aria-sort", "none"); b.addEventListener("click", () => { ascending = hasSorted && sort === i ? !ascending : true; sort = i; hasSorted = true; columns.forEach((_, index) => tr.children[index].setAttribute("aria-sort", index === sort ? (ascending ? "ascending" : "descending") : "none")); draw(); }); th.append(b); }
          else th.textContent = column;
          tr.append(th);
        });
        function draw() {
          const filtered = rows.filter(row => row.join(" ").toLowerCase().includes(query.toLowerCase()));
          if (sort >= 0) filtered.sort((a, b) => a[sort].localeCompare(b[sort], undefined, { numeric: true }) * (ascending ? 1 : -1));
          body.replaceChildren(); filtered.forEach(row => { const tr = el("tr"); row.forEach(cell => tr.append(el("td", cell))); body.append(tr); });
          if (!filtered.length) { const tr = el("tr"), td = el("td", "No matching rows"); td.colSpan = Math.max(1, columns.length); tr.append(td); body.append(tr); }
        }
        if (item.type === "grid") { const filter = el("input"); filter.placeholder = "Filter rows"; filter.setAttribute("aria-label", "Filter rows"); filter.addEventListener("input", () => { query = filter.value; draw(); }); section.append(filter); }
        head.append(tr); table.append(head, body); const wrap = el("div", null, "table-wrap"); wrap.append(table); section.append(wrap); draw(); break;
      }
      case "input": {
        const id = typeof item.id === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.id) ? item.id : "";
        if (!id || ["__proto__", "constructor", "prototype"].includes(id)) { section.append(el("p", "Invalid input")); break; }
        const label = el("label", null, "field"); label.append(el("span", item.label || id));
        const kind = ["number", "text", "select", "slider"].includes(item.kind) ? item.kind : "number";
        const input = el(kind === "select" ? "select" : "input");
        if (kind === "select") { (Array.isArray(item.options) ? item.options : []).slice(0, 100).forEach(value => { const option = el("option", value); option.value = String(value); input.append(option); }); }
        else input.type = kind === "slider" ? "range" : kind;
        if (kind === "slider" || kind === "number") {
          if (Number.isFinite(item.min)) input.min = String(item.min);
          if (Number.isFinite(item.max)) input.max = String(item.max);
          input.step = Number.isFinite(item.step) && item.step > 0 ? String(item.step) : "any";
        }
        input.value = String(item.value ?? (kind === "text" ? "" : 0));
        const read = () => { values[id] = input.value.trim() !== "" && Number.isFinite(Number(input.value)) ? Number(input.value) : input.value; refresh(); };
        read(); input.addEventListener("input", read); input.addEventListener("change", read); label.append(input); section.append(label); break;
      }
      case "calculator": {
        const output = el("output", "—", "result"); output.setAttribute("aria-label", String(item.label || "Result")); output.setAttribute("aria-live", "polite");
        section.append(el("span", item.label || "Result", "muted"), output); calculators.push({ output, expression: item.expression }); break;
      }
      case "callout": section.classList.add("callout"); section.append(el("p", item.text || "")); break;
      case "progress": { const p = el("progress"); p.max = 100; p.value = Number.isFinite(item.value) ? Math.max(0, Math.min(100, item.value)) : 0; p.setAttribute("aria-label", String(item.label || "Progress")); section.append(el("p", (item.label || "Progress") + ": " + p.value + "%"), p); break; }
      case "checklist": (Array.isArray(item.items) ? item.items : []).slice(0, 100).forEach(row => { const label = el("label", null, "check"), box = el("input"); box.type = "checkbox"; box.checked = row?.done === true; label.append(box, el("span", row?.text || "")); section.append(label); }); break;
      case "tabs": {
        const tabs = (Array.isArray(item.tabs) ? item.tabs : []).slice(0, 10), buttons = el("div", null, "tabs"); buttons.setAttribute("role", "tablist");
        const panels = tabs.map((tab, index) => { const button = el("button", tab.label || "Tab " + (index + 1)); button.type = "button"; button.setAttribute("role", "tab");
          const panel = el("div"); panel.setAttribute("role", "tabpanel"); panel.hidden = index !== 0; button.setAttribute("aria-selected", String(index === 0));
          (Array.isArray(tab.blocks) ? tab.blocks : []).slice(0, 40).forEach(block => component(panel, block, depth + 1));
          button.addEventListener("click", () => { panels.forEach(({ p, b }, i) => { p.hidden = i !== index; b.setAttribute("aria-selected", String(i === index)); }); }); buttons.append(button); return { p: panel, b: button };
        }); section.append(buttons, ...panels.map(pair => pair.p)); break;
      }
      case "chart": {
        const rows = (Array.isArray(item.data) ? item.data : []).slice(0, 100).filter(row => row && Number.isFinite(row.value)).map(row => ({ label: String(row.label || ""), value: Math.max(0, Math.min(1e12, row.value)) }));
        const total = rows.reduce((sum, row) => sum + row.value, 0), max = Math.max(1, ...rows.map(row => row.value));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 600 240"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", String(item.title || "Chart"));
        const colors = ["#4d8dff", "#6ec9a8", "#b49aff", "#f3b76c"];
        let angle = -Math.PI / 2;
        rows.forEach((row, index) => {
          let shape;
          if (item.chart === "pie" && total > 0) {
            const next = angle + row.value / total * Math.PI * 2;
            shape = document.createElementNS(svg.namespaceURI, "path");
            const end = next - (next - angle >= Math.PI * 2 ? 0.000001 : 0);
            shape.setAttribute("d", `M 300 120 L ${300 + 100 * Math.cos(angle)} ${120 + 100 * Math.sin(angle)} A 100 100 0 ${end - angle > Math.PI ? 1 : 0} 1 ${300 + 100 * Math.cos(end)} ${120 + 100 * Math.sin(end)} Z`); angle = next;
          } else if (item.chart === "line") {
            if (!index) return;
            const previous = rows[index - 1]; shape = document.createElementNS(svg.namespaceURI, "line");
            shape.setAttribute("x1", String((index - 1) * 580 / Math.max(1, rows.length - 1) + 10)); shape.setAttribute("x2", String(index * 580 / Math.max(1, rows.length - 1) + 10));
            shape.setAttribute("y1", String(220 - previous.value / max * 200)); shape.setAttribute("y2", String(220 - row.value / max * 200)); shape.setAttribute("stroke", colors[0]); shape.setAttribute("stroke-width", "3");
          } else { shape = document.createElementNS(svg.namespaceURI, "rect"); shape.setAttribute("x", String(index * 600 / Math.max(1, rows.length))); shape.setAttribute("y", String(220 - row.value / max * 200)); shape.setAttribute("width", String(540 / Math.max(1, rows.length))); shape.setAttribute("height", String(row.value / max * 200)); }
          shape.setAttribute("fill", colors[index % colors.length]); svg.append(shape);
        });
        section.append(svg); rows.forEach(row => section.append(el("span", row.label + ": " + row.value + "  ", "legend"))); break;
      }
      default: section.append(el("p", "This component could not be displayed.", "muted"));
    }
  }
  window.addEventListener("message", event => {
    // Sandboxed documents have an opaque security origin; the parent's origin is still the URL's origin.
    if (event.source !== parent || event.origin !== window.location.origin || event.data?.type !== "page:render" || typeof event.data.source !== "string" || event.data.source.length > 262144) return;
    root.replaceChildren(); document.documentElement.classList.toggle("light", event.data.theme === "light");
    values = Object.create(null); calculators = []; count = 0;
    parsePage(event.data.source).forEach(block => component(root, block, 0)); refresh();
    parent.postMessage({ type: "page:rendered", channel: event.data.channel }, event.origin);
  });
  parent.postMessage({ type: "page:ready" }, "*");
}

export const rendererCss = `:root{color-scheme:dark;--bg:#141414;--fg:#e7e9ea;--muted:#92969a;--line:#303236;--soft:#202225}.light{color-scheme:light;--bg:#fff;--fg:#202124;--muted:#687078;--line:#e2e4e7;--soft:#f5f6f7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:380 14px/1.65 Inter,system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:28px 32px 64px}.block{margin:0 0 20px}h1{font-size:28px;letter-spacing:-.7px}h2{font-size:22px}h3{font-size:16px}h1,h2,h3,h4{font-weight:600;line-height:1.3;margin:18px 0 12px}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}input,select,button{font:450 13px Inter,system-ui,sans-serif;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:8px 10px}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #4d8dff;outline-offset:2px}input:not([type=checkbox]):not([type=range]),select{max-width:100%;width:240px}.field{display:flex;flex-direction:column;gap:6px}.check{display:flex;align-items:center;gap:8px;margin:9px 0}.result{display:block;font-size:30px;font-weight:600;margin-top:4px}.muted,.legend{color:var(--muted);font-size:12px}.table-wrap{overflow:auto;margin-top:12px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere;max-width:400px}th{font-weight:600}th button{padding:0;border:0;background:transparent;font-weight:600}.callout{background:var(--soft);border-left:3px solid #4d8dff;padding:12px 16px;border-radius:4px}.tabs{display:flex;gap:8px;border-bottom:1px solid var(--line);padding-bottom:8px}.tabs [aria-selected=true]{background:var(--soft)}progress{width:100%;accent-color:#4d8dff}svg{width:100%;max-height:300px}code{font-size:12px;background:var(--soft);padding:2px 4px;border-radius:3px}@media(max-width:600px){main{padding:20px 16px}}`;

export function rendererBundle() {
  return [sanitizeMarkdown, evaluateExpression, parsePage, runRenderer].map(fn => fn.toString()).join("\n") + "\nrunRenderer();";
}
