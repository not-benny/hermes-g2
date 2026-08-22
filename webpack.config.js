const webpack = require("@nativescript/webpack");
const { resolve } = require("path");
const { Compilation, sources } = require("webpack");

class StripWorkspacePathsPlugin {
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("StripWorkspacePathsPlugin", (compilation) => {
			compilation.hooks.processAssets.tap(
				{ name: "StripWorkspacePathsPlugin", stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE },
				(assets) => {
					const workspace = resolve(__dirname);
					for (const name of Object.keys(assets).filter((asset) => asset.endsWith(".mjs"))) {
						const content = assets[name].source().toString().split(workspace).join(".");
						compilation.updateAsset(name, new sources.RawSource(content));
					}
				},
			);
		});
	}
}

module.exports = (env) => {
	webpack.init(env);

	// Learn how to customize:
	// https://docs.nativescript.org/webpack

	// Bundle the top-level project docs so the Settings app's About section
	// can display them (see app/ui/dashboard/settings-menus.ts).
	for (const doc of ["README.md", "LICENSE", "PRIVACY", "ACKNOWLEDGEMENTS.md"]) {
		webpack.Utils.addCopyRule({
			from: resolve(__dirname, doc),
			to: "about/",
		});
	}

	const config = webpack.resolveConfig();
	// Release artifacts must not embed local absolute paths through source maps.
	config.devtool = false;
	config.plugins.push(new StripWorkspacePathsPlugin());
	return config;
};
