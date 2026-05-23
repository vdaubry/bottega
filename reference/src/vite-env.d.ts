/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Settings panel hook — DashboardPage installs an opener on window so
// nested pages can request the modal without prop-drilling.
interface Window {
  openSettings?: (tab?: string) => void;
  webkit?: {
    messageHandlers?: {
      nativeApp?: {
        postMessage: (message: { action: string; userId?: string }) => void;
      };
    };
  };
}
