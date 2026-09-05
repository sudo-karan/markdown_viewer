/*
 * Public per-deployment configuration.
 *
 * IMPORTANT: A Google OAuth *Client ID* is NOT a secret. It is designed to be
 * shipped in browser code and is safe to commit here. (Never put a client
 * *secret*, an API key with write scope, or a service-account key in a static
 * site — a GitHub Pages site cannot keep secrets.)
 *
 * Leave googleClientId empty to configure it at runtime from the in-app
 * Settings dialog instead (stored in your browser's localStorage). See
 * docs/README.md for step-by-step setup.
 */
window.MO_STUDIO_CONFIG = {
  // Google OAuth 2.0 Client ID (type: Web application).
  //
  // Set this ONCE for the deployment and it becomes the app's sign-in system:
  // every visitor clicks "Sign in with Google" and gets their own account, their
  // own documents in their own Drive, on any device they sign in from. Nobody
  // but you ever has to touch a Client ID. Several people can share one browser
  // — each account's documents are kept separate.
  //
  // Leave it empty and the app still works, but only as a signed-out,
  // this-browser-only editor (each person would have to paste their own ID in
  // Settings). See docs/README.md for the 2-minute setup.
  googleClientId: "",

  // Name of the root folder in your Google Drive that this app manages. The app
  // only ever sees this folder and the subfolders/files it creates inside it —
  // never the rest of your Drive (drive.file scope).
  driveFolderName: "markdowns",
};
