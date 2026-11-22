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

  const script = document.querySelector('script[src*="pagead2.googlesyndication.com"]');
  script?.addEventListener("error", hideAll);

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
      if (ins.dataset.adInit || wrap.hidden) return;
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
