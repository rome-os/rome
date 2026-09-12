// Shared stealth payload used by both the Docker CDP guard and the desktop app.
// Injected via Page.addScriptToEvaluateOnNewDocument before page scripts run.

(() => {
  "use strict";

  const configuredLanguages = globalThis.__ROME_STEALTH_LANGUAGES__;
  try {
    delete globalThis.__ROME_STEALTH_LANGUAGES__;
  } catch {}

  // Replacing native properties can make ordinary Chrome fail site compatibility checks.
  if (navigator.webdriver !== true) {
    return;
  }

  const NATIVE_FUNCTION_STRINGS = new WeakMap();
  const originalFunctionToString = Function.prototype.toString;

  const markAsNative = (fn, name) => {
    if (typeof fn !== "function") {
      return fn;
    }
    NATIVE_FUNCTION_STRINGS.set(fn, `function ${name || fn.name || ""}() { [native code] }`);
    return fn;
  };

  Function.prototype.toString = new Proxy(originalFunctionToString, {
    apply(target, thisArg, args) {
      if (NATIVE_FUNCTION_STRINGS.has(thisArg)) {
        return NATIVE_FUNCTION_STRINGS.get(thisArg);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  markAsNative(Function.prototype.toString, "toString");

  const defineGetter = (obj, prop, getter) => {
    Object.defineProperty(obj, prop, {
      get: getter,
      configurable: true,
    });
    markAsNative(Object.getOwnPropertyDescriptor(obj, prop).get, `get ${prop}`);
  };

  const normalizeLanguages = (languages) => {
    if (!Array.isArray(languages)) {
      return [];
    }
    return languages
      .filter((language) => typeof language === "string")
      .map((language) => language.trim())
      .filter(Boolean);
  };

  const getNavigatorLanguages = () => {
    const configured = normalizeLanguages(configuredLanguages);
    if (configured.length > 0) {
      return configured;
    }

    const existing = normalizeLanguages(navigator.languages);
    if (existing.length > 0) {
      return existing;
    }

    const language = typeof navigator.language === "string" ? navigator.language.trim() : "";
    if (!language) {
      return ["en-US", "en"];
    }

    const baseLanguage = language.split("-")[0];
    if (baseLanguage && baseLanguage !== language) {
      return [language, baseLanguage];
    }

    return [language];
  };

  // 1. navigator.webdriver
  defineGetter(navigator, "webdriver", () => undefined);

  // 2. navigator.languages
  const navigatorLanguages = Object.freeze(getNavigatorLanguages());
  defineGetter(navigator, "languages", () => [...navigatorLanguages]);

  // 3. navigator.plugins / navigator.mimeTypes
  if (navigator.plugins.length === 0) {
    const pluginData = [
      {
        name: "PDF Viewer",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        mimeTypes: [
          { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
        ],
      },
      {
        name: "Chrome PDF Viewer",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        mimeTypes: [{ type: "application/pdf", suffixes: "pdf", description: "" }],
      },
      {
        name: "Chromium PDF Viewer",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        mimeTypes: [{ type: "application/pdf", suffixes: "pdf", description: "" }],
      },
      {
        name: "Microsoft Edge PDF Viewer",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        mimeTypes: [{ type: "application/pdf", suffixes: "pdf", description: "" }],
      },
      {
        name: "WebKit built-in PDF",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        mimeTypes: [{ type: "application/pdf", suffixes: "pdf", description: "" }],
      },
    ];

    const makeMimeType = (mt, plugin) => {
      const obj = Object.create(MimeType.prototype);
      Object.defineProperties(obj, {
        type: { get: () => mt.type },
        suffixes: { get: () => mt.suffixes },
        description: { get: () => mt.description },
        enabledPlugin: { get: () => plugin },
      });
      return obj;
    };

    const makePlugin = (pd) => {
      const plugin = Object.create(Plugin.prototype);
      const mimes = pd.mimeTypes.map((mt) => makeMimeType(mt, plugin));
      Object.defineProperties(plugin, {
        name: { get: () => pd.name },
        description: { get: () => pd.description },
        filename: { get: () => pd.filename },
        length: { get: () => mimes.length },
      });
      mimes.forEach((mimeType, index) => {
        Object.defineProperty(plugin, index, { get: () => mimeType });
        Object.defineProperty(plugin, mimeType.type, { get: () => mimeType });
      });
      plugin[Symbol.iterator] = markAsNative(function* iterator() {
        yield* mimes;
      }, "values");
      return plugin;
    };

    const plugins = pluginData.map(makePlugin);
    const pluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(pluginArray, "length", { get: () => plugins.length });
    plugins.forEach((plugin, index) => {
      Object.defineProperty(pluginArray, index, { get: () => plugin });
      Object.defineProperty(pluginArray, plugin.name, { get: () => plugin });
    });
    pluginArray[Symbol.iterator] = markAsNative(function* iterator() {
      yield* plugins;
    }, "values");
    pluginArray.refresh = markAsNative(() => {}, "refresh");
    pluginArray.namedItem = markAsNative(
      (name) => plugins.find((plugin) => plugin.name === name) || null,
      "namedItem",
    );
    pluginArray.item = markAsNative((index) => plugins[index] || null, "item");

    defineGetter(navigator, "plugins", () => pluginArray);

    const allMimes = plugins.flatMap((plugin) => Array.from(plugin));
    const mimeArray = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(mimeArray, "length", { get: () => allMimes.length });
    allMimes.forEach((mimeType, index) => {
      Object.defineProperty(mimeArray, index, { get: () => mimeType });
      Object.defineProperty(mimeArray, mimeType.type, { get: () => mimeType });
    });
    mimeArray[Symbol.iterator] = markAsNative(function* iterator() {
      yield* allMimes;
    }, "values");
    mimeArray.namedItem = markAsNative(
      (name) => allMimes.find((mimeType) => mimeType.type === name) || null,
      "namedItem",
    );
    mimeArray.item = markAsNative((index) => allMimes[index] || null, "item");

    defineGetter(navigator, "mimeTypes", () => mimeArray);
  }

  // 4. window.chrome
  if (!window.chrome || !window.chrome.runtime) {
    const chrome = window.chrome || {};

    chrome.app = chrome.app || {
      isInstalled: false,
      InstallState: {
        DISABLED: "disabled",
        INSTALLED: "installed",
        NOT_INSTALLED: "not_installed",
      },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails: markAsNative(() => null, "getDetails"),
      getIsInstalled: markAsNative(() => false, "getIsInstalled"),
      installState: markAsNative((cb) => {
        if (typeof cb === "function") {
          cb("not_installed");
        }
      }, "installState"),
    };

    chrome.csi =
      chrome.csi ||
      markAsNative(
        () => ({
          onloadT: Date.now(),
          startE: Date.now(),
          pageT: performance.now(),
          tran: 15,
        }),
        "csi",
      );

    chrome.loadTimes =
      chrome.loadTimes ||
      markAsNative(() => {
        const perf = performance.timing;
        return {
          commitLoadTime: perf.responseStart / 1000,
          connectionInfo: "http/1.1",
          finishDocumentLoadTime: perf.domContentLoadedEventEnd / 1000,
          finishLoadTime: perf.loadEventEnd / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: perf.domContentLoadedEventEnd / 1000,
          navigationType: "Other",
          npnNegotiatedProtocol: "unknown",
          requestTime: perf.requestStart / 1000,
          startLoadTime: perf.navigationStart / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
        };
      }, "loadTimes");

    chrome.runtime = chrome.runtime || {
      OnInstalledReason: {
        CHROME_UPDATE: "chrome_update",
        INSTALL: "install",
        SHARED_MODULE_UPDATE: "shared_module_update",
        UPDATE: "update",
      },
      OnRestartRequiredReason: {
        APP_UPDATE: "app_update",
        OS_UPDATE: "os_update",
        PERIODIC: "periodic",
      },
      PlatformArch: {
        ARM: "arm",
        MIPS: "mips",
        MIPS64: "mips64",
        X86_32: "x86-32",
        X86_64: "x86-64",
      },
      PlatformNaclArch: {
        ARM: "arm",
        MIPS: "mips",
        MIPS64: "mips64",
        X86_32: "x86-32",
        X86_64: "x86-64",
      },
      PlatformOs: {
        ANDROID: "android",
        CROS: "cros",
        LINUX: "linux",
        MAC: "mac",
        OPENBSD: "openbsd",
        WIN: "win",
      },
      RequestUpdateCheckStatus: {
        NO_UPDATE: "no_update",
        THROTTLED: "throttled",
        UPDATE_AVAILABLE: "update_available",
      },
      connect: markAsNative(
        () => ({
          onDisconnect: { addListener: markAsNative(() => {}, "addListener") },
          onMessage: { addListener: markAsNative(() => {}, "addListener") },
          postMessage: markAsNative(() => {}, "postMessage"),
          disconnect: markAsNative(() => {}, "disconnect"),
        }),
        "connect",
      ),
      sendMessage: markAsNative((...args) => {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          callback(undefined);
        }
      }, "sendMessage"),
    };

    window.chrome = chrome;
  }

  // 5. WebGL renderer/vendor
  const spoofWebGL = (proto) => {
    if (!proto || typeof proto.getParameter !== "function") {
      return;
    }

    const originalGetParameter = proto.getParameter;
    const originalGetExtension =
      typeof proto.getExtension === "function" ? proto.getExtension : null;

    proto.getParameter = markAsNative(function getParameter(param) {
      if (param === 0x9245) return "Google Inc. (Intel)";
      if (param === 0x9246)
        return "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)";
      if (param === 0x1f00) return "WebKit";
      if (param === 0x1f01) return "WebKit WebGL";
      return originalGetParameter.call(this, param);
    }, "getParameter");

    if (originalGetExtension) {
      proto.getExtension = markAsNative(function getExtension(name) {
        return originalGetExtension.call(this, name);
      }, "getExtension");
    }
  };

  if (typeof WebGLRenderingContext !== "undefined") {
    spoofWebGL(WebGLRenderingContext.prototype);
  }
  if (typeof WebGL2RenderingContext !== "undefined") {
    spoofWebGL(WebGL2RenderingContext.prototype);
  }

  // 6. Screen dimensions
  const screenProps = {
    width: () => 1280,
    height: () => 800,
    availWidth: () => 1280,
    availHeight: () => 800,
    colorDepth: () => 24,
    pixelDepth: () => 24,
    availLeft: () => 0,
    availTop: () => 0,
  };
  Object.entries(screenProps).forEach(([prop, getter]) => defineGetter(screen, prop, getter));

  defineGetter(window, "outerWidth", () => window.innerWidth);
  defineGetter(window, "outerHeight", () => window.innerHeight);

  // 7. navigator.connection
  if (!navigator.connection) {
    const connection = {
      effectiveType: "4g",
      rtt: 50,
      downlink: 10,
      saveData: false,
      type: "wifi",
      onchange: null,
      addEventListener: markAsNative(() => {}, "addEventListener"),
      removeEventListener: markAsNative(() => {}, "removeEventListener"),
      dispatchEvent: markAsNative(() => true, "dispatchEvent"),
    };
    defineGetter(navigator, "connection", () => connection);
  }

  // 8. Notification.permission + navigator.permissions consistency
  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    defineGetter(Notification, "permission", () => "default");
  }

  if (navigator.permissions && typeof navigator.permissions.query === "function") {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    const patchedResults = new WeakSet();
    navigator.permissions.query = markAsNative((params) => {
      if (params && params.name === "notifications") {
        return originalQuery(params).then((result) => {
          if (!patchedResults.has(result)) {
            patchedResults.add(result);
            defineGetter(result, "state", () =>
              Notification.permission === "default" ? "prompt" : Notification.permission,
            );
          }
          return result;
        });
      }
      return originalQuery(params);
    }, "query");
  }

  // 9. navigator.hardwareConcurrency
  if (navigator.hardwareConcurrency > 8) {
    defineGetter(navigator, "hardwareConcurrency", () => 8);
  }

  // 10. navigator.deviceMemory
  if (!navigator.deviceMemory || navigator.deviceMemory > 8) {
    defineGetter(navigator, "deviceMemory", () => 8);
  }
})();
