{
  description = "Safelight — a fast, cross-platform RAW photo editor";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        inherit (pkgs) lib;

        # Pull name/version/metadata straight from package.json so the flake
        # never drifts from the source of truth (e.g. the release tag check).
        pkg = lib.importJSON ./package.json;

        # nixpkgs ships a patched, self-contained Electron — use it instead of
        # the binary the `electron` npm package downloads at install time.
        electron = pkgs.electron;

        safelight = pkgs.buildNpmPackage {
          pname = pkg.name;
          inherit (pkg) version;

          src = ./.;

          # Hash of the fixed-output npm dependency fetch. Recompute whenever
          # package-lock.json changes — the build error prints the correct value,
          # or run:  nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          npmDepsHash = "sha256-Cp7SYeVhP2lX9BOzm+LA1OjQwmmlgK4dK2EenpLEESo=";

          # nixpkgs supplies Electron, so skip the npm postinstall that would try
          # to download a (sandbox-blocked) prebuilt binary.
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

          # `npm run build` == `tsc && vite build` → dist/. A pure-JS toolchain
          # with no native compile step, so the standard `npm ci` install works.
          npmBuildScript = "build";

          nativeBuildInputs = [
            pkgs.makeWrapper
            pkgs.copyDesktopItems
          ];

          # The runtime payload mirrors exactly what electron-builder ships (see
          # package.json "build.files"): the built renderer (dist/), the main +
          # preload (electron/), and package.json for app.getVersion(). No
          # node_modules are needed at runtime.
          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/safelight
            cp -r dist electron package.json $out/share/safelight/

            install -Dm644 public/favicon.svg \
              $out/share/icons/hicolor/scalable/apps/safelight.svg

            # Wrap nixpkgs' Electron around the app directory. SAFELIGHT_PACKAGED
            # makes main.cjs take the packaged code path (no dev DevTools), and
            # vulkan-loader lets the ANGLE "vulkan" backend probe in main.cjs find
            # libvulkan at runtime.
            makeWrapper ${electron}/bin/electron $out/bin/safelight \
              --add-flags $out/share/safelight \
              --set SAFELIGHT_PACKAGED 1 \
              --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath [ pkgs.vulkan-loader ]}"

            runHook postInstall
          '';

          desktopItems = [
            (pkgs.makeDesktopItem {
              name = "safelight";
              exec = "safelight %U";
              icon = "safelight";
              desktopName = "Safelight";
              comment = pkg.description or "Fast RAW photo editor";
              categories = [
                "Graphics"
                "Photography"
              ];
              # A representative subset of package.json "build.linux.mimeTypes".
              mimeTypes = [
                "image/jpeg"
                "image/png"
                "image/tiff"
                "image/webp"
                "image/x-adobe-dng"
                "image/x-nikon-nef"
                "image/x-canon-cr2"
                "image/x-canon-cr3"
                "image/x-sony-arw"
              ];
            })
          ];

          meta = {
            description = pkg.description or "Fast RAW photo editor";
            homepage = pkg.homepage or "https://github.com/anthonyreimche/SafeLight";
            license = lib.licenses.gpl3Only;
            platforms = pkgs.lib.platforms.linux;
            mainProgram = "safelight";
          };
        };
      in
      {
        packages = {
          default = safelight;
          safelight = safelight;
        };

        apps.default = {
          type = "app";
          program = "${safelight}/bin/safelight";
        };

        # `nix develop` — the toolchain to build/run locally without packaging.
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_20
            pkgs.electron
          ];
        };
      }
    );
}
