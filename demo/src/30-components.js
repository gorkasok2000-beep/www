// ---------------------------------------------------------------------
// Примитивы: те же классы, что в apps/web/src/components/ui
// ---------------------------------------------------------------------

const icon = (name, cls = "size-4") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
  `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
  `stroke-linejoin="round" class="lucide lucide-${name} ${cls}" aria-hidden="true">` +
  `${T.icons[name] || ""}</svg>`;

/** `attrs` — сырые атрибуты (например, style для каскада появления). */
const card = (inner, extra = "", attrs = "") =>
  `<div data-slot="card" data-size="default" class="${T.card} ${extra}" ${attrs}>${inner}</div>`;
const cardHeader = (inner, extra = "") =>
  `<div data-slot="card-header" class="${T.cardHeader} ${extra}">${inner}</div>`;
const cardTitle = (inner, extra = "") =>
  `<div data-slot="card-title" class="${T.cardTitle} ${extra}">${inner}</div>`;
const cardContent = (inner, extra = "") =>
  `<div data-slot="card-content" class="${T.cardContent} ${extra}">${inner}</div>`;

const badge = (text, variant = "secondary", extra = "") => {
  const cls = {
    secondary: T.badge,
    outline: T.badgeOutline,
    destructive: T.badgeDestructive,
  }[variant];
  return `<span data-slot="badge" data-variant="${variant}" class="${cls} ${extra}">${text}</span>`;
};

/** Крутилка для кнопок: длинные операции (PBKDF2) не должны выглядеть зависанием. */
const spinner = (cls = "size-4") =>
  `<svg class="${cls} animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
  `<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25"/>` +
  `<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`;

/** @param {{variant?:string,size?:string,act?:string,extra?:string,disabled?:boolean,href?:string,pending?:boolean,arg?:string}} o */
const button = (label, o = {}) => {
  const variant = o.variant || "default";
  const size = o.size || "md";
  const key = "btn" + variant[0].toUpperCase() + variant.slice(1) + {lg: "Lg", md: "Md", sm: "Sm"}[size];
  const cls = `${T[key]} ${o.extra || ""}`;
  const body = o.pending ? `${spinner()}${label}` : label;

  if (o.href) {
    return `<a href="${o.href}" data-slot="button" class="${cls}">${body}</a>`;
  }
  return (
    `<button type="button" data-slot="button" class="${cls}"` +
    `${o.act ? ` data-act="${o.act}"` : ""}${o.arg ? ` data-arg="${esc(o.arg)}"` : ""}` +
    `${o.disabled || o.pending ? " disabled" : ""}>${body}</button>`
  );
};

const input = (o = {}) =>
  `<input data-slot="input" class="${T.input} ${o.extra || ""}" ` +
  `${o.id ? `id="${o.id}" ` : ""}${o.model ? `data-model="${o.model}" ` : ""}` +
  `${o.label ? `aria-label="${esc(o.label)}" ` : ""}` +
  `type="${o.type || "text"}" value="${esc(o.value ?? "")}" ` +
  `placeholder="${esc(o.placeholder ?? "")}" ` +
  `inputmode="${o.inputmode || "text"}" autocomplete="${o.autocomplete || "off"}">`;

const toggle = (checked, act, arg = "") => {
  const stateAttr = checked ? 'data-checked=""' : 'data-unchecked=""';
  return (
    `<span role="switch" tabindex="0" aria-checked="${checked}" ${stateAttr} ` +
    `data-slot="switch" data-size="default" data-act="${act}"` +
    `${arg ? ` data-arg="${esc(arg)}"` : ""} class="${T.switch}">` +
    `<span ${stateAttr} data-slot="switch-thumb" class="${T.switchThumb}"></span></span>`
  );
};

const progress = (percent) =>
  `<div role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" ` +
  `data-slot="progress" class="${T.progress} h-2">` +
  `<div data-slot="progress-track" class="${T.progressTrack}">` +
  `<div data-slot="progress-indicator" style="height:inherit;width:${percent}%" ` +
  `class="${T.progressInd} sw-bar"></div></div></div>`;

// ---------------------------------------------------------------------
// Составные блоки
// ---------------------------------------------------------------------

const sectionHeading = (eyebrow, title, subtitle) => `
  <div class="mx-auto max-w-2xl text-center">
    <p class="text-sm font-medium text-muted-foreground">${eyebrow}</p>
    <h2 class="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">${title}</h2>
    ${subtitle ? `<p class="mt-4 text-base text-muted-foreground">${subtitle}</p>` : ""}
  </div>`;

const pageTitle = (title, subtitle) => `
  <div>
    <h1 class="text-2xl font-medium tracking-tight">${title}</h1>
    ${subtitle ? `<p class="mt-2 text-sm text-muted-foreground">${subtitle}</p>` : ""}
  </div>`;

const emptyState = (text) =>
  `<div class="rounded-xl border border-dashed p-10 text-center">
     <p class="text-sm text-muted-foreground">${text}</p>
   </div>`;

const statCard = (ic, label, value, hint) =>
  card(
    cardHeader(
      `${cardTitle(label, "text-sm font-medium text-muted-foreground")}
       <div class="flex size-8 items-center justify-center rounded-lg bg-muted">${icon(ic, "size-4 text-muted-foreground")}</div>`,
      "flex flex-row items-center justify-between space-y-0 pb-2",
    ) +
      cardContent(
        `<p class="text-2xl font-bold tabular-nums tracking-tight">${value}</p>
         <p class="mt-1 text-xs text-muted-foreground">${hint}</p>`,
      ),
  );

/** Поле только для чтения с кнопкой копирования: адреса и ключи набирать руками нельзя. */
const copyField = (value, {mono = true, act = "copy", label = "Копировать"} = {}) => `
  <div class="flex items-center gap-2">
    <code class="min-w-0 flex-1 truncate rounded-md border bg-background px-3 py-2 ${mono ? "font-mono" : ""} text-xs">${esc(value)}</code>
    ${button(`${icon("copy", "size-3.5")}${label}`, {
      variant: "outline",
      size: "sm",
      act,
      arg: value,
      extra: "shrink-0 gap-1.5",
    })}
  </div>`;

const errorBlock = (message) =>
  message
    ? `<div class="sw-fade flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
         ${icon("triangle-alert", "mt-0.5 size-4 shrink-0 text-destructive")}
         <p class="text-sm text-destructive">${esc(message)}</p>
       </div>`
    : "";

const noticeBlock = (message) =>
  message
    ? `<p class="sw-fade flex items-center gap-2 text-sm text-muted-foreground">
         ${icon("check", "size-4")}${esc(message)}
       </p>`
    : "";

const feedback = () => errorBlock(state.error) + (state.error ? "" : noticeBlock(state.notice));

/** Каскад появления: задержка растёт по индексу, но не бесконечно. */
const stagger = (index) => `style="animation-delay:${Math.min(index, 7) * 45}ms"`;
