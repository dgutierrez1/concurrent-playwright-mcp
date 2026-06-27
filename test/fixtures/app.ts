/**
 * A small but realistic, styled multi-page app used by the e2e test. Served from
 * an in-process HTTP server so the e2e stays deterministic and offline while
 * exercising real DOM, client-side JS, navigation, and localStorage — and
 * looking like a real app when run headed (PW_HEADLESS=false).
 */

const PRICES: Record<string, string> = {
  AAPL: "$190.12",
  MSFT: "$420.55",
  NVDA: "$120.30",
  AMZN: "$178.20",
  GOOGL: "$155.90",
};

const STOCKS: { sym: string; name: string }[] = [
  { sym: "AAPL", name: "Apple" },
  { sym: "MSFT", name: "Microsoft" },
  { sym: "NVDA", name: "Nvidia" },
  { sym: "AMZN", name: "Amazon" },
  { sym: "GOOGL", name: "Alphabet" },
];

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Acme</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: #f1f5f9; color: #0f172a; }
  header { background: #0f172a; color: #fff; padding: 12px 20px; display: flex; gap: 16px; align-items: center; }
  header .brand { font-weight: 700; margin-right: auto; }
  header a { color: #cbd5e1; text-decoration: none; font-size: 14px; }
  header a:hover { color: #fff; }
  header .cart { background: #6366f1; border-radius: 999px; padding: 2px 10px; font-size: 13px; }
  main { max-width: 720px; margin: 32px auto; padding: 0 20px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  h1 { margin: 0 0 16px; font-size: 24px; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; font-size: 13px; color: #334155; }
  input, select, textarea { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; background: #fff; }
  textarea { min-height: 90px; }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 14px; }
  .row input[type=checkbox] { width: auto; }
  button { margin-top: 18px; background: #6366f1; color: #fff; border: 0; border-radius: 8px; padding: 11px 18px; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #4f46e5; }
  ul { list-style: none; padding: 0; margin: 16px 0 0; }
  li { padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; margin: 8px 0; background: #fff; }
  li a { text-decoration: none; color: #0f172a; font-weight: 600; }
  .product { display: flex; justify-content: space-between; align-items: center; }
  .price { font-size: 30px; font-weight: 700; color: #6366f1; }
  .muted { color: #64748b; }
</style></head>
<body>
<header>
  <span class="brand">Acme</span>
  <a href="/login">Login</a>
  <a href="/search">Search</a>
  <a href="/contact">Contact</a>
  <a href="/shop">Shop</a>
  <a href="/board">Board</a>
  <span class="cart">Cart: <span id="cart">0</span></span>
</header>
<main><div class="card">${body}</div></main>
</body></html>`;
}

function loginPage(): string {
  return layout(
    "Login",
    `<h1>Sign in</h1>
    <label for="user">Username</label>
    <input id="user" aria-label="Username" />
    <label for="pass">Password</label>
    <input id="pass" type="password" aria-label="Password" />
    <label for="plan">Plan</label>
    <select id="plan" aria-label="Plan">
      <option value="free">Free</option>
      <option value="pro">Pro</option>
      <option value="team">Team</option>
    </select>
    <div class="row"><input type="checkbox" id="remember" aria-label="Remember me" /><span>Remember me</span></div>
    <button id="signin">Sign in</button>
    <script>
      document.getElementById('signin').addEventListener('click', function () {
        localStorage.setItem('user', document.getElementById('user').value);
        localStorage.setItem('plan', document.getElementById('plan').value);
        location.href = '/app';
      });
    </script>`,
  );
}

function appPage(): string {
  return layout(
    "Dashboard",
    `<h1 id="welcome"></h1>
    <p class="muted">Your isolated dashboard.</p>
    <script>
      var user = localStorage.getItem('user');
      document.getElementById('welcome').textContent = user
        ? 'Welcome ' + user + ' · ' + localStorage.getItem('plan')
        : 'Not signed in';
    </script>`,
  );
}

function searchPage(): string {
  const items = STOCKS.map(
    (s) =>
      `<li class="r" data-sym="${s.sym}"><a href="/stock?sym=${s.sym}">${s.sym} — ${s.name}</a></li>`,
  ).join("");
  return layout(
    "Search",
    `<h1>Search stocks</h1>
    <input id="q" aria-label="Search stocks" placeholder="Type a ticker…" />
    <ul id="results">${items}</ul>
    <script>
      var q = document.getElementById('q');
      var rows = Array.prototype.slice.call(document.querySelectorAll('#results .r'));
      q.addEventListener('input', function () {
        var v = q.value.toUpperCase();
        rows.forEach(function (li) {
          var hit = li.dataset.sym.includes(v) || li.textContent.toUpperCase().includes(v);
          li.style.display = hit ? '' : 'none';
        });
      });
    </script>`,
  );
}

function stockPage(sym: string): string {
  return layout(
    sym,
    `<h1 id="sym">${sym}</h1>
    <p class="muted">Last price</p>
    <p class="price" id="price">${PRICES[sym] ?? "n/a"}</p>`,
  );
}

function contactPage(): string {
  return layout(
    "Contact",
    `<h1>Contact us</h1>
    <label for="name">Name</label><input id="name" aria-label="Name" />
    <label for="email">Email</label><input id="email" aria-label="Email" />
    <label for="country">Country</label>
    <select id="country" aria-label="Country">
      <option value="us">United States</option>
      <option value="uk">United Kingdom</option>
      <option value="de">Germany</option>
    </select>
    <label for="message">Message</label><textarea id="message" aria-label="Message"></textarea>
    <div class="row"><input type="checkbox" id="subscribe" aria-label="Subscribe" /><span>Subscribe to updates</span></div>
    <button id="send">Send</button>
    <script>
      document.getElementById('send').addEventListener('click', function () {
        var name = document.getElementById('name').value;
        location.href = '/thanks?name=' + encodeURIComponent(name);
      });
    </script>`,
  );
}

function thanksPage(name: string): string {
  return layout(
    "Thanks",
    `<h1 id="thanks">Thanks, ${name}!</h1><p class="muted">We'll be in touch.</p>`,
  );
}

function shopPage(): string {
  const products = ["Widget", "Gadget", "Gizmo"]
    .map(
      (p) => `<li class="product"><span>${p}</span><button data-add="${p}">Add ${p}</button></li>`,
    )
    .join("");
  return layout(
    "Shop",
    `<h1>Shop</h1>
    <ul>${products}</ul>
    <script>
      function cart() { return JSON.parse(localStorage.getItem('cart') || '[]'); }
      function render() { document.getElementById('cart').textContent = String(cart().length); }
      document.querySelectorAll('button[data-add]').forEach(function (b) {
        b.addEventListener('click', function () {
          var c = cart(); c.push(b.dataset.add); localStorage.setItem('cart', JSON.stringify(c)); render();
        });
      });
      render();
    </script>`,
  );
}

function boardPage(): string {
  return layout(
    "Board",
    `<h1>Reorder</h1>
    <ul id="board">
      <li data-id="One">One</li>
      <li data-id="Two">Two</li>
      <li data-id="Three">Three</li>
    </ul>
    <script>
      var dragging = null;
      document.querySelectorAll('#board li').forEach(function (li) {
        li.addEventListener('mousedown', function () { dragging = li; });
        li.addEventListener('mouseup', function () {
          if (dragging && dragging !== li) { li.parentNode.insertBefore(dragging, li.nextSibling); }
          dragging = null;
        });
      });
    </script>`,
  );
}

/** Render the page for a request URL. The only entry point used by the e2e server. */
export function serve(url: string): string {
  const parsed = new URL(url, "http://localhost");
  switch (parsed.pathname) {
    case "/login":
      return loginPage();
    case "/app":
      return appPage();
    case "/search":
      return searchPage();
    case "/stock":
      return stockPage(parsed.searchParams.get("sym") ?? "");
    case "/contact":
      return contactPage();
    case "/thanks":
      return thanksPage(parsed.searchParams.get("name") ?? "there");
    case "/shop":
      return shopPage();
    case "/board":
      return boardPage();
    default:
      return layout("Acme", `<h1>Acme</h1><p class="muted">A demo app for the e2e suite.</p>`);
  }
}
