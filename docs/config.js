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

  // Name of the root folder this app creates in your Google Drive. It is an
  // ordinary folder in "My Drive" — you can open, move and rename it from the
  // Drive website like any other. (The drive.file scope limits what the *app*
  // can see, not what *you* can see.)
  driveFolderName: "markdown_sudo-karan",

  // Folder names this deployment used before. If the folder above doesn't exist
  // yet but one of these does, the app renames that one instead of starting a
  // new empty folder — so changing driveFolderName never strands documents.
  legacyDriveFolderNames: ["markdowns"],
};
