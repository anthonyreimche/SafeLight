// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Live numbers and lists for the website, read in the visitor's browser from
// the extension registry and SUPPORTERS.md, so the pages never go stale and
// nothing is baked in. A page marks what to fill:
//
//   <span data-live="extensions">        count of listed extensions (also
//                                        "developers" and "verified")
//   <div data-live-list="popular">       one copy of its <template> per item
//     <template> … <img data-field="thumbnail"> <a data-field="link">
//               … <span data-field="name"> <span data-show="verified"> …
//   lists: "popular", "developers", "supporters", "library"
//   <div data-live-ready hidden>         shown once the data has arrived
//
// Images and links fill src and href; anything else gets text, never HTML.
// When the data can't be read, marked parts stay hidden.

(function (root) {
  "use strict";

  var REGISTRY_URL = "https://cdn.jsdelivr.net/gh/anthonyreimche/safelight-registry/registry.json";
  var VERIFIED_URL = "https://raw.githubusercontent.com/anthonyreimche/safelight-registry/main/verified.json";
  var SUPPORTERS_URL = "https://raw.githubusercontent.com/anthonyreimche/SafeLight/main/SUPPORTERS.md";
  /** A transparent pixel: an image that won't load keeps its frame, empty. */
  var BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  function lower(s) {
    return String(s).toLowerCase();
  }
  function https(url) {
    return typeof url === "string" && /^https:\/\//i.test(url) ? url : "";
  }
  function owner(entry) {
    return entry.fullName.split("/")[0];
  }

  function listed(index) {
    var all = index && Array.isArray(index.extensions) ? index.extensions : [];
    return all.filter(function (e) {
      return e && typeof e.fullName === "string" && e.fullName.indexOf("/") > 0 && !e.deprecated;
    });
  }

  function verifiedSet(verified) {
    var set = {};
    var list = verified && Array.isArray(verified.verified) ? verified.verified : [];
    list.forEach(function (v) {
      var repo = typeof v === "string" ? v : v && typeof v.repo === "string" ? v.repo : "";
      if (repo) set[lower(repo)] = true;
    });
    return set;
  }

  function summary(index, verified) {
    var entries = listed(index);
    var isVerified = verifiedSet(verified);
    var owners = {};
    var verifiedCount = 0;
    entries.forEach(function (e) {
      owners[lower(owner(e))] = true;
      if (isVerified[lower(e.fullName)]) verifiedCount += 1;
    });
    return { extensions: entries.length, developers: Object.keys(owners).length, verified: verifiedCount };
  }

  function number(v) {
    return typeof v === "number" && isFinite(v) ? v : 0;
  }

  /** Most downloaded first, then most starred, then most recently updated. */
  function popular(index, verified, count) {
    var isVerified = verifiedSet(verified);
    return listed(index)
      .slice()
      .sort(function (a, b) {
        return (
          number(b.downloads) - number(a.downloads) ||
          number(b.stars) - number(a.stars) ||
          String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
        );
      })
      .slice(0, count)
      .map(function (e) {
        return card(e, isVerified);
      });
  }

  function card(e, isVerified) {
    return {
      name: typeof e.name === "string" && e.name ? e.name : e.fullName.split("/")[1],
      repo: e.fullName,
      author: owner(e),
      description: typeof e.description === "string" ? e.description : "",
      thumbnail: https(e.thumbnail && e.thumbnail.url),
      link: "https://github.com/" + e.fullName,
      verified: !!isVerified[lower(e.fullName)],
    };
  }

  /** Every listed extension A to Z, with category labels to show and slugs to filter by. */
  function library(index, verified) {
    var isVerified = verifiedSet(verified);
    var labels = {};
    (index && Array.isArray(index.categories) ? index.categories : []).forEach(function (c) {
      if (c && typeof c.slug === "string") labels[c.slug] = typeof c.label === "string" ? c.label : c.slug;
    });
    return listed(index)
      .map(function (e) {
        var slugs = (Array.isArray(e.categories) ? e.categories : []).filter(function (s) {
          return typeof s === "string" && /^[a-z0-9-]+$/.test(s);
        });
        var item = card(e, isVerified);
        item.categories = slugs
          .map(function (s) {
            return labels[s] || s;
          })
          .join(", ");
        item.slugs = slugs.join(" ");
        return item;
      })
      .sort(function (a, b) {
        return lower(a.name).localeCompare(lower(b.name));
      });
  }

  /** One row per account, in alphabetical order: nobody is ranked. */
  function developers(index) {
    var byOwner = {};
    listed(index).forEach(function (e) {
      var key = lower(owner(e));
      if (!byOwner[key]) byOwner[key] = { login: owner(e), avatar: https(e.avatarUrl), n: 0 };
      byOwner[key].n += 1;
    });
    return Object.keys(byOwner)
      .sort()
      .map(function (key) {
        var d = byOwner[key];
        return {
          login: d.login,
          avatar: d.avatar,
          link: "https://github.com/" + d.login,
          count: d.n + (d.n === 1 ? " extension" : " extensions"),
        };
      });
  }

  /** The "Bought a coffee" list in SUPPORTERS.md, alphabetically. */
  function supporters(markdown) {
    var lines = String(markdown || "").split(/\r?\n/);
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^##\s.*coffee/i.test(lines[i])) {
        start = i + 1;
        break;
      }
    }
    if (start < 0) return [];
    var people = [];
    for (var j = start; j < lines.length && !/^#/.test(lines[j]); j++) {
      var m = /^-\s+(.+?)\s*$/.exec(lines[j]);
      if (!m) continue;
      var link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(m[1]);
      people.push(link ? { name: link[1].trim(), link: https(link[2]) } : { name: m[1], link: "" });
    }
    return people.sort(function (a, b) {
      return lower(a.name).localeCompare(lower(b.name));
    });
  }

  // ── Filling the page ──────────────────────────────────────────────────

  function fillItem(node, item) {
    Array.prototype.forEach.call(node.querySelectorAll("[data-field]"), function (el) {
      var value = item[el.getAttribute("data-field")];
      if (el.tagName === "IMG") {
        if (value) el.setAttribute("src", value);
        else el.remove();
      } else if (el.tagName === "A") {
        if (value) el.setAttribute("href", value);
        else el.removeAttribute("href");
      } else {
        el.textContent = value === undefined || value === null ? "" : String(value);
      }
    });
    // data-attr="data-categories=slugs" copies a field into a data-* attribute.
    Array.prototype.forEach.call(node.querySelectorAll("[data-attr]"), function (el) {
      var pair = /^(data-[a-z-]+)=(\w+)$/.exec(el.getAttribute("data-attr") || "");
      if (pair) el.setAttribute(pair[1], String(item[pair[2]] == null ? "" : item[pair[2]]));
    });
    Array.prototype.forEach.call(node.querySelectorAll("[data-show]"), function (el) {
      if (!item[el.getAttribute("data-show")]) el.remove();
    });
  }

  function fillList(doc, name, items) {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-live-list="' + name + '"]'), function (list) {
      var template = list.querySelector("template");
      if (!template) return;
      // A picture that won't load leaves its empty frame, not a broken-image icon.
      list.addEventListener(
        "error",
        function (e) {
          if (e.target && e.target.tagName === "IMG" && e.target.src !== BLANK) e.target.src = BLANK;
        },
        true,
      );
      var limit = Number(list.getAttribute("data-live-limit")) || items.length;
      var made = items.slice(0, limit).map(function (item) {
        var copy = template.content.cloneNode(true);
        fillItem(copy, item);
        return copy;
      });
      made.forEach(function (copy) {
        list.appendChild(copy);
      });
      // A looping strip scrolls through a second, hidden copy so it never ends.
      if (list.hasAttribute("data-live-loop")) {
        Array.prototype.filter
          .call(list.children, function (child) {
            return child !== template;
          })
          .forEach(function (child) {
            var twin = child.cloneNode(true);
            twin.setAttribute("aria-hidden", "true");
            twin.setAttribute("inert", "");
            list.appendChild(twin);
          });
      }
    });
  }

  function render(doc, data) {
    var counts = summary(data.index, data.verified);
    Array.prototype.forEach.call(doc.querySelectorAll("[data-live]"), function (el) {
      var key = el.getAttribute("data-live");
      if (key in counts) el.textContent = counts[key].toLocaleString("en-CA");
    });
    fillList(doc, "popular", popular(data.index, data.verified, 24));
    fillList(doc, "developers", developers(data.index));
    if (doc.querySelector('[data-live-list="library"]')) fillList(doc, "library", library(data.index, data.verified));
    if (data.supporters) fillList(doc, "supporters", supporters(data.supporters));
    Array.prototype.forEach.call(doc.querySelectorAll("[data-live-ready]"), function (el) {
      var needs = el.getAttribute("data-live-ready");
      if (needs !== "supporters" || data.supporters) el.hidden = false;
    });
    // Page scripts that build on the data (filters, say) wait for this.
    if (typeof root.CustomEvent === "function") doc.dispatchEvent(new root.CustomEvent("safelight:live", { detail: data }));
  }

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }

  function load() {
    var supportersText = fetch(SUPPORTERS_URL)
      .then(function (r) {
        return r.ok ? r.text() : null;
      })
      .catch(function () {
        return null;
      });
    return Promise.all([getJson(REGISTRY_URL), getJson(VERIFIED_URL).catch(function () { return null; }), supportersText]).then(
      function (parts) {
        return { index: parts[0], verified: parts[1], supporters: parts[2] };
      },
    );
  }

  function start() {
    var doc = root.document;
    if (!doc || !doc.querySelector("[data-live], [data-live-list], [data-live-ready]")) return;
    load()
      .then(function (data) {
        render(doc, data);
      })
      .catch(function () {
        // Marked parts stay hidden: no made-up numbers when the registry can't be read.
      });
  }

  root.SafelightLive = {
    summary: summary,
    popular: popular,
    developers: developers,
    supporters: supporters,
    library: library,
    render: render,
    load: load,
  };

  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : this);
