// 検証用フィクスチャサイト（docs/design.md §11.1）
// 状態は /__state で変更できる（item内容の変更、0件化、構造破損、エラー注入）。
import http from "node:http";

const state = {
  itemsVersion: 1, // 2 にすると item 2 のタイトルが変わる
  extraItem: false, // true にすると新規 item が増える
  empty: false,
  broken: false,
  failPage: null, // replace ページングでこのページ番号を 500 にする
  robotsDisallow: false,
  ogImage: false, // true にすると /news/:id に og:image を付ける
};

function items() {
  const arr = [];
  const n = 12;
  for (let i = n; i >= 1; i--) {
    arr.push({
      id: i,
      title: i === 2 && state.itemsVersion >= 2 ? `お知らせ ${i}（改訂）` : `お知らせ ${i}`,
      date: `2026.11.${String(i).padStart(2, "0")}`,
      body: `本文 ${i}`,
    });
  }
  if (state.extraItem) arr.unshift({ id: 13, title: "お知らせ 13（新着）", date: "2026.11.13", body: "本文 13" });
  return arr;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function li(it) {
  return `<li class="news-item"><a class="title" href="/news/${it.id}">${esc(it.title)}</a><time datetime="2026-11-${String(it.id).padStart(2, "0")}">${it.date}</time><span class="tag">info</span><span class="tag">event</span></li>`;
}

function page(title, body, script = "") {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><link rel="alternate" type="application/rss+xml" href="/rss.xml" title="RSS"></head><body><header><h1>${title}</h1></header><main>${body}</main>${script}</body></html>`;
}

function listHtml(list) {
  if (state.broken) return `<div class="renewal"><div class="card">${list.map((i) => `<p>${esc(i.title)}</p>`).join("")}</div></div>`;
  if (state.empty) return `<ul class="news-list"></ul><p class="no-result">お知らせはありません</p>`;
  return `<ul class="news-list">${list.map(li).join("")}</ul>`;
}

const routes = {
  "/rss.xml": () => ({
    type: "application/rss+xml; charset=utf-8",
    body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:ex="http://example.com/ns/ext">
<channel>
  <title>Fixture RSS</title><link>http://fixture.local/</link><description>テスト用 &lt;b&gt;RSS&lt;/b&gt;</description>
  <language>ja</language><copyright>(c) Fixture</copyright>
  <managingEditor>editor@example.com (Editor Name)</managingEditor><webMaster>web@example.com</webMaster>
  <ttl>60</ttl><docs>https://www.rssboard.org/rss-specification</docs><rating>(PICS-1.1)</rating>
  <cloud domain="rpc.example.com" port="80" path="/RPC2" registerProcedure="pingMe" protocol="soap"/>
  <skipHours><hour>0</hour><hour>1</hour></skipHours><skipDays><day>Sunday</day></skipDays>
  <textInput><title>Search</title><description>Search</description><name>q</name><link>http://fixture.local/search</link></textInput>
  <atom:link rel="self" href="http://fixture.local/rss.xml" type="application/rss+xml"/>
  <ex:custom attr="1">channel ext</ex:custom>
  ${items()
    .slice(0, 5)
    .map(
      (it) => `<item>
    <title>${esc(it.title)}</title><link>/news/${it.id}</link>
    <description>&lt;p&gt;${esc(it.body)}&lt;/p&gt;</description>
    <content:encoded><![CDATA[<p>${esc(it.body)} 全文</p>]]></content:encoded>
    <guid isPermaLink="false">tag:fixture,2026:${it.id}</guid>
    <pubDate>Mon, ${String(it.id).padStart(2, "0")} Nov 2026 10:00:00 +0900</pubDate>
    <author>writer@example.com (Writer)</author>
    <category domain="http://fixture.local/cat">info</category>
    <comments>http://fixture.local/news/${it.id}#comments</comments>
    <enclosure url="http://fixture.local/a/${it.id}.mp3" length="12345" type="audio/mpeg"/>
    <ex:rank>${it.id}</ex:rank>
  </item>`,
    )
    .join("\n")}
</channel></rss>`,
  }),
  "/atom.xml": () => ({
    type: "application/atom+xml; charset=utf-8",
    body: `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ja" xml:base="http://fixture.local/">
  <id>http://fixture.local/feed-id</id><title type="text">Fixture Atom</title><subtitle type="html">&lt;em&gt;sub&lt;/em&gt;</subtitle>
  <updated>2026-11-12T10:00:00+09:00</updated>
  <author><name>Feed Author</name><email>a@example.com</email><uri>/about</uri></author>
  <link rel="alternate" href="/"/><link rel="self" href="/atom.xml"/>
  <generator uri="https://example.com/gen" version="1.2">Gen</generator>
  <icon>/favicon.ico</icon><rights>CC BY</rights>
  ${items()
    .slice(0, 4)
    .map(
      (it) => `<entry>
    <id>http://fixture.local/entry/${it.id}?a=1#x</id>
    <title type="html">${esc(it.title)} &amp;lt;b&amp;gt;</title>
    <link href="/news/${it.id}"/>
    <updated>2026-11-${String(it.id).padStart(2, "0")}T12:00:00Z</updated>
    <published>2026-11-${String(it.id).padStart(2, "0")}</published>
    <summary>${esc(it.body)}</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>${esc(it.body)} <b>xhtml</b></p></div></content>
    <category term="info" scheme="http://fixture.local/cat" label="Info"/>
  </entry>`,
    )
    .join("\n")}
  <entry><id>urn:uuid:ext-src</id><title>external</title><updated>2026-11-01T00:00:00Z</updated>
    <content src="/media/1.pdf" type="application/pdf"/>
    <source><id>http://other.example/feed</id><title>Other</title><updated>2026-10-01T00:00:00Z</updated></source>
  </entry>
</feed>`,
  }),
  "/static/list": () => ({ type: "text/html; charset=utf-8", body: page("Static News", listHtml(items())) }),
  "/js/list": () => ({
    type: "text/html; charset=utf-8",
    body: page(
      "JS News",
      `<div id="app"><p class="loading">loading...</p></div>`,
      `<script>
        setTimeout(function(){ fetch('/api/items').then(r=>r.json()).then(function(d){
          document.getElementById('app').innerHTML = d.html;
        }); }, 600);
      </script>`,
    ),
  }),
  "/api/items": () => ({ type: "application/json", body: JSON.stringify({ html: listHtml(items()) }) }),
  "/append": () => ({
    type: "text/html; charset=utf-8",
    body: page(
      "Append News",
      `<ul class="news-list"></ul><button class="more" type="button">もっと見る</button>`,
      `<script>
        var all = ${JSON.stringify(items().map(li))}; var shown = 0;
        function more(){ var ul=document.querySelector('.news-list'); var btn=document.querySelector('.more');
          btn.disabled = true;
          setTimeout(function(){ all.slice(shown, shown+4).forEach(function(h){ ul.insertAdjacentHTML('beforeend', h); }); shown += 4;
            if (shown >= all.length) btn.remove(); else btn.disabled = false; }, 400); }
        document.querySelector('.more').addEventListener('click', more); more();
      </script>`,
    ),
  }),
  "/replace": () => ({
    type: "text/html; charset=utf-8",
    body: page(
      "Replace News",
      `<div class="list-wrap"><ul class="news-list"></ul></div><nav><button class="next" type="button">次へ</button></nav>`,
      `<script>
        var all = ${JSON.stringify(items().map(li))}; var p = 0; var per = 5; var failPage = ${JSON.stringify(state.failPage)};
        function render(){ var ul=document.querySelector('.news-list'); ul.innerHTML='';
          setTimeout(function(){
            if (failPage !== null && p === failPage) { ul.innerHTML=''; return; }
            ul.innerHTML = all.slice(p*per, p*per+per).join('');
            var btn = document.querySelector('.next'); if ((p+1)*per >= all.length) btn.setAttribute('disabled',''); }, 300); }
        document.querySelector('.next').addEventListener('click', function(){ p++; render(); }); render();
      </script>`,
    ),
  }),
  "/cycle": () => ({
    type: "text/html; charset=utf-8",
    body: page("Cycle", `<ul class="news-list">${items().slice(0, 3).map(li).join("")}</ul><a class="next" href="/cycle">次へ</a>`),
  }),
  "/multi-next": () => ({
    type: "text/html; charset=utf-8",
    body: page("Multi", `<ul class="news-list">${items().slice(0, 3).map(li).join("")}</ul><a class="next" href="/multi-next?p=2">次へ</a><a class="next" href="/multi-next?p=2">次へ</a>`),
  }),
  "/robots.txt": () => ({ type: "text/plain", body: state.robotsDisallow ? "User-agent: Web-Subscriber\nDisallow: /static/\n" : "User-agent: *\nDisallow: /private/\n" }),
};

for (let i = 1; i <= 13; i++)
  routes[`/news/${i}`] = () => {
    const html = page(`News ${i}`, `<article>本文 ${i}</article>`);
    const og = `<meta content="/img/news-${i}.jpg?a=1&amp;b=2" property="og:image">`;
    return { type: "text/html; charset=utf-8", body: state.ogImage ? html.replace("<head>", `<head>${og}`) : html };
  };

export function createFixtureServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__state") {
      if (req.method === "POST") {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          Object.assign(state, JSON.parse(b || "{}"));
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
        });
        return;
      }
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
    }
    if (u.pathname === "/error/500") return res.writeHead(500).end("error");
    if (u.pathname === "/error/404") return res.writeHead(404).end("not found");
    if (u.pathname === "/slow") return; // 応答しない
    // 2ページ目以降をリンク遷移で辿る replace（URL遷移あり）
    if (u.pathname === "/paged") {
      const p = Number(u.searchParams.get("p") ?? 1);
      if (state.failPage !== null && p === state.failPage) return res.writeHead(500).end("error");
      const list = items().slice((p - 1) * 5, p * 5);
      const next = p * 5 < items().length ? `<a class="next" href="/paged?p=${p + 1}">次へ</a>` : `<span class="next disabled" aria-disabled="true">次へ</span>`;
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(`Paged ${p}`, `<ul class="news-list">${list.map(li).join("")}</ul>${next}`));
    }
    const r = routes[u.pathname];
    if (!r) return res.writeHead(404).end("not found");
    const out = r();
    res.writeHead(200, { "content-type": out.type }).end(out.body);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8790);
  createFixtureServer().listen(port, "127.0.0.1", () => console.log(`fixtures on http://127.0.0.1:${port}`));
}
