/* 外部（収益先）への離脱クリックをGA4で実測する。共通版。2026-09-02 新設。
 *
 * 正本＝ ~/Desktop/claude/tools/oc_shared.js
 * 配布先＝ 宅建GYM / 方言ラボ(public/) / 勝負ラボ / rule / BJ / トレ飯 / 雀トレ(site/) / ポータル /
 *         ポケチップ(public/→配信元 poke-chip 直下) / jp-tcg-en の10本。🔴 **全部この1ファイルと同一md5で配る。**
 *         サイトごとに変えたい値は、ファイルを分岐させずに下の SITE_UTM_SOURCE 等の「設定値」に足す。
 * 2026-09-14 統合（6版→1版）：宅建GYM独自版の author_click・BOOK_MAP・utm_source=takkengym をここへ取り込み、
 *   宅建GYMの「一問一答の達成度（端末内保存）」は /ichimon-progress.js に分離した（計測ではないため）。
 *   勝負ラボのシミュレータ実行 sim_run は /betting/app.js・/koei/app.js 側で送っている（ここには無い）。
 *   経緯＝ memory/analytics_snapshot.md「2026-09-14 oc.js の版ズレ解消」
 *
 * 背景：2026-09-02 に「計測を実装した」と「全ページに入っている」を取り違えた事故が3件出た。
 * 楽天アフィリのレポートは計測ID未登録のためサイト別・記事別を返さないので、
 * 「そのリンクが踏まれたのか」を知る手段は GA4 のこのイベント以外に存在しない。
 *
 * 送るイベント（3サイトで名前を揃えてある＝月次で横に並べて読める）：
 *   kindle_click { book, from_page, slot }
 *   note_click   { note_id, product, from_page, slot }
 *   aff_click    { network, item_id, from_page, slot }   network = a8 | rakuten | vc | gumroad
 *
 * slot＝リンク（またはその祖先）の `data-aff` 属性。どの枠から踏まれたかを分解するため。
 * 例：RAKUTEN_HOGEN_* / RAKUTEN_BJ_BOOK1 / A8_YOTSUYA / VC_LEC。属性が無ければ空文字。
 * 🔑 方言ラボの 9/27「楽天書籍リンク4週判定」は slot 別のクリック数が判定材料なので、
 *    この項目を落とすと判定できなくなる（2026-09-02 に共通版へ寄せた際の必須要件）。
 *
 * 🔴 このファイルにAdSenseコードを足さないこと（shoubu-lab 系は隔離ドメイン）。
 * 注意：gtag 未ロード（広告ブロッカー等）でも例外を投げない。UIを壊さないこと優先。
 *
 * 検査：`python3 ~/Desktop/claude/tools/tracking_audit.py` で全URLに入っているかを機械的に見る。
 */
(function () {
  /* Kindle の ASIN → GA4 に送る book の名前。載っていない ASIN は ASIN のまま送る。
     🔴 名前を途中で変えると判定日に系列が割れる（chinkan_jobun は 9/2 から送っている）。 */
  var BOOK_MAP = {
    B0HFW15W4R: "chinkan_jobun", // 第1弾 賃管士 条文で確かめる要点ノート
    B0HHMT59G2: "takken_houkaisei" // 第3弾 宅建 法改正ノート【令和8年度】
  };

  /* utm_source をホスト名の先頭ラベルから変えたいサイトだけ書く（設定値）。
     宅建GYM は 2026-09-02 から "takkengym" で付けてきた系列を維持する。 */
  var SITE_UTM_SOURCE = {
    takken: "takkengym"
  };

  var NOTE_MAP = {
    ne2376058ec7b: "note_takken_980",
    n7f126d2e8522: "note_ai_980",
    ne087a09b24d4: "note_iriguchi_300",
    n50a7bb4bf933: "note_free_kubun",
    n574a0c6a6056: "note_free_nochiho"
  };

  /* リンク自身か祖先の data-aff（掲載枠のID）。無ければ空文字。
     宅建GYM/BJ は <a> 自身に、方言ラボは囲みの PrBox に付いている＝closest で両方拾う。 */
  function slotOf(a) {
    try {
      var el = a.closest("[data-aff]");
      return (el && el.getAttribute("data-aff")) || "";
    } catch (e) {
      return "";
    }
  }

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
      var slot = slotOf(a);

      if (href.indexOf("amazon.co.jp") > -1 || href.indexOf("amzn.to") > -1) {
        /* 著者ページ（/stores/author/<ID> と旧形式 /<name>/e/<ID>）は商品ページではないので別イベント。
           2026-09-04 宅建GYM独自版で追加 → 2026-09-14 正本へ取り込み。
           ここで先に返さないと /dp/ 抽出が外れて kindle_click{book:"unknown"} に落ち、系列が汚れる。 */
        if (href.indexOf("/stores/author/") > -1 || /\/e\/B0[A-Z0-9]{8}/.test(href)) {
          send("author_click", { author: "fujikken", from_page: from, slot: slot });
          return;
        }
        var asin = href.match(/\/dp\/([A-Z0-9]{10})/);
        asin = asin ? asin[1] : "unknown";
        send("kindle_click", {
          book: BOOK_MAP[asin] || asin,
          from_page: from,
          slot: slot
        });
        return;
      }

      if (href.indexOf("note.com/fujiken818") > -1) {
        var k = href.match(/\/n\/(n[0-9a-z]+)/);
        var id = k ? k[1] : "unknown";
        send("note_click", {
          note_id: id,
          product: NOTE_MAP[id] || "note_other",
          from_page: from,
          slot: slot
        });
        return;
      }

      if (href.indexOf("px.a8.net") > -1) {
        send("aff_click", { network: "a8", item_id: "unknown", from_page: from, slot: slot });
        return;
      }

      if (href.indexOf("hb.afl.rakuten.co.jp") > -1) {
        var r = href.match(/item\.rakuten\.co\.jp%2F[^%]+%2F([^%/&]+)/i) ||
                href.match(/item\.rakuten\.co\.jp%2Fbook%2F(\d+)/i);
        send("aff_click", {
          network: "rakuten",
          item_id: r ? r[1] : "unknown",
          from_page: from,
          slot: slot
        });
        return;
      }

      /* Gumroad（自社デジタル商品）。2026-09-09 追加。
         ポータル /story に販売ページへのリンクがあるのに、どのネットワークにも
         当たらず「タグはあるが測れていない」状態だった（週次計測検査で検出）。
         item_id は /l/<permalink> の permalink。 */
      if (href.indexOf("gumroad.com") > -1) {
        var g = href.match(/\/l\/([A-Za-z0-9_-]+)/);
        send("aff_click", {
          network: "gumroad",
          item_id: g ? g[1] : "unknown",
          from_page: from,
          slot: slot
        });
        return;
      }

      /* 自社の別サイト（*.mainichi-lab.com / mainichi-lab.com）への離脱クリック。
         2026-09-04 追加。方言ラボが全流入の84%を持つのに他資産への導線が0本で、
         導線を置いても「踏まれたか」を測る手段が存在しなかったため新設した。
         🔴 shoubu-lab 系（ギャンブル隔離ドメイン）は対象外。クリーン側と相互リンクしない。 */
      var mcross = href.match(/^https?:\/\/([a-z0-9.-]*mainichi-lab\.com)/i);
      if (mcross) {
        var toHost = mcross[1].toLowerCase();
        if (toHost !== location.hostname.toLowerCase()) {
          send("cross_click", {
            to_site:
              toHost === "mainichi-lab.com" || toHost === "www.mainichi-lab.com"
                ? "portal"
                : toHost.split(".")[0],
            from_page: from,
            slot: a.getAttribute("data-cross") || slot
          });
          return;
        }
      }

      /* バリューコマース。ck. が離脱クリック用、ad. は表示計測の img なので拾わない */
      if (href.indexOf("ck.jp.ap.valuecommerce.com") > -1) {
        var v = href.match(/[?&]pid=(\d+)/);
        send("aff_click", {
          network: "vc",
          item_id: v ? v[1] : "unknown",
          from_page: from,
          slot: slot
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
  var UTM_SOURCE = SITE_UTM_SOURCE[host] || (host === "www" ? "portal" : host);

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

  /* ---- 自社の別サイトへのリンクへ utm 自動付与（保険） --------------------
   * 2026-09-04 追加。本文に置いた導線は href に静的な utm を書いてある
   * （oc.js が届く前にクリックされても取りこぼさないため）。
   * ここで拾うのは「フッタの毎日ラボリンク」のように utm が付いていない既存リンク。
   * utm_source = ホスト名の先頭ラベル / utm_medium = inline / utm_campaign = cross_2026q3
   * ⚠️ 送り先が同じGA4プロパティ（毎日ラボ共通ストリーム）なので、utm が付くと
   *    GA4はそこで**新しいセッション**を開始する。セッション数がわずかに増える副作用がある。
   * -------------------------------------------------------------------- */
  function decorateCrossLinks() {
    var slug = pageSlug();
    var list = document.querySelectorAll('a[href*="mainichi-lab.com"]');
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var href = a.getAttribute("href") || "";
      if (href.indexOf("utm_source=") > -1) continue; // 二重付与しない
      var m = href.match(/^https?:\/\/([a-z0-9.-]*mainichi-lab\.com)/i);
      if (!m) continue; // mailto: や相対リンクは対象外
      if (m[1].toLowerCase() === location.hostname.toLowerCase()) continue; // 自サイト内は対象外
      a.setAttribute(
        "href",
        href +
          (href.indexOf("?") > -1 ? "&" : "?") +
          "utm_source=" + UTM_SOURCE +
          "&utm_medium=" + (a.getAttribute("data-utm-medium") || "inline") +
          "&utm_campaign=cross_2026q3" +
          "&utm_content=" + slug
      );
    }
  }

  function decorateAll() {
    decorateNoteLinks();
    decorateCrossLinks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", decorateAll);
  } else {
    decorateAll();
  }
})();
