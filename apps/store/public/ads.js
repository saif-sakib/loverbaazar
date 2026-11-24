// Lazy-initializes approved manual AdSense slots and collapses unfilled or blocked slots.
(() => {
  "use strict";
  const wrappers = [...document.querySelectorAll("[data-ad-slot-wrap]")];
  if (!wrappers.length) return;

  const pairs = wrappers
    .map((wrap) => [wrap, wrap.querySelector("ins.adsbygoogle")])
    .filter(([, ins]) => ins);
  if (!pairs.length) return;

  const hideAll = () => {
    pairs.forEach(([wrap]) => {
      wrap.hidden = true;
    });
  };

  const providerURL = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
  let script = document.querySelector(`script[src^="${providerURL}"]`);
  script?.addEventListener("error", hideAll);

  function loadProvider(client) {
    if (!/^ca-pub-\d{16}$/.test(client || "")) return false;
    if (script) return true;
    script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.fetchPriority = "low";
    script.src = `${providerURL}?client=${encodeURIComponent(client)}`;
    script.addEventListener("error", hideAll, { once: true });
    document.head.append(script);
    return true;
  }

  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          entry.target._activateAd?.();
        });
      }, { rootMargin: "300px 0px" })
    : null;

  pairs.forEach(([wrap, ins]) => {
    if (ins.dataset.adStatus === "unfilled") {
      wrap.hidden = true;
      return;
    }

    const observer = new MutationObserver(() => {
      if (ins.dataset.adStatus === "unfilled") {
        wrap.hidden = true;
        observer.disconnect();
      }
    });
    observer.observe(ins, { attributes: true, attributeFilter: ["data-ad-status"] });

    const activate = () => {
      if (ins.dataset.adInit || wrap.hidden || !wrap.getClientRects().length) return;
      if (wrap.hasAttribute("data-ad-defer-script") && !loadProvider(ins.dataset.adClient)) {
        wrap.hidden = true;
        observer.disconnect();
        return;
      }
      ins.dataset.adInit = "1";
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        wrap.hidden = true;
        observer.disconnect();
        return;
      }
      setTimeout(() => {
        if (!ins.dataset.adStatus && ins.childElementCount === 0) {
          wrap.hidden = true;
          observer.disconnect();
        }
      }, 6000);
    };

    if (io) {
      wrap._activateAd = activate;
      io.observe(wrap);
    } else {
      activate();
    }
  });
})();
