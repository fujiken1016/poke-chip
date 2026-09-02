/* 外部（収益先）への離脱クリックをGA4で実測する。共通版。2026-09-02 新設。
 *
 * 正本＝ ~/Desktop/claude/tools/oc_shared.js
 * 配布先＝ 雀トレ / トレ飯 / ポータル / ポケチップ / rule.shoubu-lab.com の各リポジトリ直下 `oc.js`
 * （宅建GYM・勝負ラボは先行して独自版があるので、そちらは差分だけ手で合わせる）
 *
 * 背景：2026-09-02 に「計測を実装した」と「全ページに入っている」を取り違えた事故が3件出た。
 * 楽天アフィリのレポートは計測ID未登録のためサイト別・記事別を返さないので、
 * 「そのリンクが踏まれたのか」を知る手段は GA4 のこのイベント以外に存在しない。
 *
 * 送るイベント（3サイトで名前を揃えてある＝月次で横に並べて読める）：
 *   kindle_click { book, from_page }
 *   note_click   { note_id, product, from_page }
 *   aff_click    { network, item_id, from_page }   network = a8 | rakuten | vc
 *
 * 🔴 このファイルにAdSenseコードを足さないこと（shoubu-lab 系は隔離ドメイン）。
 * 注意：gtag 未ロード（広告ブロッカー等）でも例外を投げない。UIを壊さないこと優先。
 *
 * 検査：`python3 ~/Desktop/claude/tools/tracking_audit.py` で全URLに入っているかを機械的に見る。
 */
(function () {
  var NOTE_MAP = {
    ne2376058ec7b: "note_takken_980",
    n7f126d2e8522: "note_ai_980",
    ne087a09b24d4: "note_iriguchi_300",
    n50a7bb4bf933: "note_free_kubun",
    n574a0c6a6056: "note_free_nochiho"
  };

  function send(name, params) {
    try {
      if (window.gtag) window.gtag("event", name, params);
    } catch (e) {
      /* 計測失敗でUIを壊さない */
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      var from = location.pathname;

      if (href.indexOf("amazon.co.jp") > -1 || href.indexOf("amzn.to") > -1) {
        var asin = href.match(/\/dp\/([A-Z0-9]{10})/);
        asin = asin ? asin[1] : "unknown";
        send("kindle_click", {
          book: asin === "B0HFW15W4R" ? "chinkan_jobun" : asin,
          from_page: from
        });
        return;
      }

      if (href.indexOf("note.com/fujiken818") > -1) {
        var k = href.match(/\/n\/(n[0-9a-z]+)/);
        var id = k ? k[1] : "unknown";
        send("note_click", {
          note_id: id,
          product: NOTE_MAP[id] || "note_other",
          from_page: from
        });
        return;
      }

      if (href.indexOf("px.a8.net") > -1) {
        send("aff_click", { network: "a8", item_id: "unknown", from_page: from });
        return;
      }

      if (href.indexOf("hb.afl.rakuten.co.jp") > -1) {
        var r = href.match(/item\.rakuten\.co\.jp%2F[^%]+%2F([^%/&]+)/i) ||
                href.match(/item\.rakuten\.co\.jp%2Fbook%2F(\d+)/i);
        send("aff_click", {
          network: "rakuten",
          item_id: r ? r[1] : "unknown",
          from_page: from
        });
        return;
      }

      /* バリューコマース。ck. が離脱クリック用、ad. は表示計測の img なので拾わない */
      if (href.indexOf("ck.jp.ap.valuecommerce.com") > -1) {
        var v = href.match(/[?&]pid=(\d+)/);
        send("aff_click", {
          network: "vc",
          item_id: v ? v[1] : "unknown",
          from_page: from
        });
        return;
      }
    },
    true
  );

  /* ---- note リンクへの utm 自動付与 -------------------------------------
   * utm_source   = ホスト名の先頭ラベル（takken / mahjong / meshi / chip …）
   * utm_medium   = owned_site（data-utm-medium で個別上書き可）
   * utm_campaign = 送客先の商品（NOTE_MAP の値＝note_click の product と同じ）
   * utm_content  = 送り出したページのスラッグ
   * ※ note側に流入元レポートは存在しない（2026-09-02 実測）。実際に読めるのは
   *    自社側の note_click の方で、utm は将来・人が見る時のための保険。
   * 🔴 HTML の href に utm を書かない。ここで一元的に付ける。
   * -------------------------------------------------------------------- */
  var host = location.hostname.split(".")[0] || "site";
  var UTM_SOURCE = host === "www" ? "portal" : host;

  function pageSlug() {
    var p = location.pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
    p = p.replace(/^\/+|\/+$/g, "").replace(/[\/.]/g, "_");
    return p || "home";
  }

  function decorateNoteLinks() {
    var slug = pageSlug();
    var list = document.querySelectorAll('a[href*="note.com/fujiken818"]');
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var href = a.getAttribute("href") || "";
      if (href.indexOf("utm_source=") > -1) continue; // 二重付与しない
      var k = href.match(/\/n\/(n[0-9a-z]+)/);
      var camp = (k && NOTE_MAP[k[1]]) || "note_other";
      var med = a.getAttribute("data-utm-medium") || "owned_site";
      a.setAttribute(
        "href",
        href +
          (href.indexOf("?") > -1 ? "&" : "?") +
          "utm_source=" + UTM_SOURCE +
          "&utm_medium=" + med +
          "&utm_campaign=" + camp +
          "&utm_content=" + slug
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", decorateNoteLinks);
  } else {
    decorateNoteLinks();
  }
})();
