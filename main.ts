import {App, debounce, Plugin, PluginSettingTab, Setting} from "obsidian";
import Color from "colorjs.io";
import {coloredClassApplyerPlugin} from "./coloredClassApplyerPlugin";

interface ColoredTagsPluginSettings {
	chroma: number;
	lightness: number;
	palette: number;
	seed: number;
	knownTags: {
		[name: string]: number
	};
	_version: number;
	enableCustomColors?: boolean;
	customColors?: string[];
}

const DEFAULT_SETTINGS: ColoredTagsPluginSettings = {
	chroma: 16,
	lightness: 87,
	palette: 16,
	seed: 0,
	knownTags: {},
	_version: 2,
	enableCustomColors: true,
}

export default class ColoredTagsPlugin extends Plugin {
	renderedTagsSet: Set<string> = new Set();
	tagsMap: Map<string, number>;

	settings: ColoredTagsPluginSettings;
	palettes = {
		light: [],
		dark: []
	}

	async onload() {
		await this.loadSettings();
		this.tagsMap = new Map(Object.entries(this.settings.knownTags));

		this.app.workspace.onLayoutReady(async () => {
			await this.saveKnownTags();
			this.reload();

			this.registerEvent(
				this.app.workspace.on("editor-change", debounce(async () => {
					await this.saveKnownTags();
					this.update();
				}, 3000, true))
			);

			this.registerEvent(
				this.app.workspace.on("active-leaf-change", debounce(async () => {
					await this.saveKnownTags();
					this.update();
				}, 300, true))
			);

			this.addSettingTab(new ColoredTagsPluginSettingTab(this.app, this));
			this.registerEditorExtension(coloredClassApplyerPlugin);
		});
	}

	// O(n^2)
	// Need to be optimized
	async saveKnownTags () {
		let isNeedToSave = false;

		const combinedSet = new Set(this.tagsMap.keys());
		this.getTagsFromApp().forEach((tag) => {
			combinedSet.add(tag);
		});
		const combinedTags = Array.from(combinedSet);
		combinedTags.forEach((tag, index) => {
			const chunks = tag.split('/');

			let combinedTag = '';
			chunks.forEach((chunk, chunkIndex) => {
				const key = [combinedTag, chunk].filter(Boolean).join('/');
				if (!this.tagsMap.has(key)) {
					const siblings = combinedTags.filter((keyd) => {
						return keyd.split('/').length === chunkIndex + 1 && keyd.startsWith(combinedTag);
					});

					const maxValue = siblings.reduce((acc, sibling) => {
						return Math.max(acc, this.tagsMap.get(sibling) || 0);
					}, 0);

					this.tagsMap.set(key, maxValue + 1);
					isNeedToSave = true;

				}

				combinedTag = key;
			});
		});

		if (isNeedToSave) {
			this.settings.knownTags = Object.fromEntries(this.tagsMap.entries());
			await this.saveData(this.settings);
		}
	}

	getTagsFromApp(): string[] {
		const tagsArray = Object.keys(this.app.metadataCache.getTags());
		return tagsArray
			.map((tag) => {
				return tag.replace(/#/g, "");
			})
			.filter((tag) => !tag.match(/\/$/))
			.filter((x) => x.length);
	}

	update() {
		const tags = this.tagsMap;
		tags.forEach((order, tagName) => {
			if (!this.renderedTagsSet.has(tagName)) {
				this.renderedTagsSet.add(tagName);
				this.colorizeTag(tagName);
			}
		});
	}

	reload() {
		this.onunload();
		this.generatePalettes();
		this.update();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.reload();
	}

	getColors(
		input: string,
		palette,
	): { background: string; color: string } {
		const chunks = input.split("/");
		let combinedTag = '';
		const background =
			chunks
				.reduce((acc, chunk, i) => {
					const key = [combinedTag, chunk].filter(Boolean).join('/');
					const order = this.tagsMap.get(key) || 1;
					const colorFromPalette = palette[(order - 1) % palette.length];

					if (acc) {
						return acc.mix(
							colorFromPalette,
							0.4,
							{space: "lch"}
						);
					}
					combinedTag = key;
					return new Color(colorFromPalette).to('lch');
				}, null)
				.toString({format: "lch"});

		const color = darkenColorForContrast(background);
		return {background, color};
	}

	colorizeTag(tagName: string) {
		tagName = tagName.replace(/#/g, "");

		const tagHref = "#" + tagName.replace(/\//g, "\\/");
		const tagFlat = tagName.replace(/[^0-9a-z-]/ig, '').toLowerCase();

		const {background: backgroundLight, color: colorLight} = this.getColors(tagName, this.palettes.light);
		const {background: backgroundDark, color: colorDark} = this.getColors(tagName, this.palettes.dark);

		const selectors = [
			`a.tag[href="${tagHref}"]`,
			`.cm-s-obsidian .cm-line span.cm-hashtag.colored-tag-${tagName.replace(/\//g, "\\/")}`
		];

		if (tagFlat) {
			selectors.push(`.cm-s-obsidian .cm-line span.cm-tag-${tagFlat}.cm-hashtag`)
		}

		const lightThemeSelectors = selectors.map(selector => 'body ' + selector);
		const darkThemeSelectors = selectors.map(selector => 'body.theme-dark ' + selector);

		appendCSS(`
			${lightThemeSelectors.join(', ')} {
				background-color: ${backgroundLight};
				color: ${colorLight};
			}
			${darkThemeSelectors.join(', ')} {
				background-color: ${backgroundDark};
				color: ${colorDark};
			}
		`);
	}

	findPaletteOffset(paletteConfig) {
		function scoreOffset (value) {
			const testingPalette = generateColorPalette({
				...paletteConfig,
				constantOffset: value
			});

			let prevColor = null;
			return testingPalette.reduce((acc, col) => {
				let score = 0;
				if (prevColor) {
					score = acc + new Color(col).contrast(prevColor, 'weber');
				}

				prevColor = col;
				return score;
			}, 0);
		}

		// More contrast means more difference in colors
		let offset = 0;
		let maxScore = 0;

		for (let i = 0; i < 180; i++) {
			const res = scoreOffset(i);
			if (res >= maxScore) {
				maxScore = res;
				offset = i;
			}
		}

		return offset;
	}

	generatePalettes() {
		if (this.settings.enableCustomColors === true) {
			this.palettes = {
				light: this.settings.customColors,
				dark: this.settings.customColors
			};
		} else {
			const commonPaletteConfig = {
				paletteSize: this.settings.palette,
				baseChroma: this.settings.chroma,
				baseLightness: this.settings.lightness,
				seed: this.settings.seed,
				isShuffling: true
			};

			const offset = this.findPaletteOffset({
				...commonPaletteConfig,
				isDarkTheme: false,
				seed: 0,
				isShuffling: false,
			});

			this.palettes = {
				light: generateColorPalette({
					isDarkTheme: false,
					...commonPaletteConfig,
					constantOffset: offset

				}),
				dark: generateColorPalette({
					isDarkTheme: true,
					...commonPaletteConfig,
					constantOffset: offset
				})
			};
		}
	}

	isValidHexColor(hexString) {
		return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hexString);
	}

	async loadSettings() {
		const loadedData = await this.loadData();

		if (loadedData && loadedData.customColors && loadedData.customColors.length) {
			loadedData.customColors = loadedData.customColors.filter((color) => {
				return this.isValidHexColor(color);
			});
		}

		let needToSave = false;

		if (loadedData && loadedData._version < 2) {
			needToSave = true;

			loadedData.palette = 16;
			loadedData._version = 2;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

		if (needToSave) {
			await this.saveData(this.settings);
		}
	}

	onunload() {
		this.renderedTagsSet.clear();
		removeCSS();
	}
}

const darkenMemoization = new Map();
function darkenColorForContrast(baseColor) {
	const CONTRAST = 4.5;
	const memoizationKey = `${baseColor}`;
	if (darkenMemoization.has(memoizationKey)) {
		return darkenMemoization.get(memoizationKey);
	}

	const colorLight = new Color(baseColor).to("lch");
	const colorDark = new Color(baseColor).to("lch");

	colorLight.c += 3;
	colorDark.c += 20;

	let result = '#fff';
	for (let i = 0; i < 100; i++) {
		if (
			colorLight.contrastAPCA(baseColor) >= 60 &&
			colorLight.contrastWCAG21(baseColor) >= CONTRAST
		) {
			result = colorLight.toString();
			break;
		}
		if (
			colorDark.contrastAPCA(baseColor) <= -60 &&
			colorDark.contrastWCAG21(baseColor) >= CONTRAST
		) {
			result = colorDark.toString();
			break;
		}

		colorLight.l++;
		colorDark.l--;
	}

	darkenMemoization.set(memoizationKey, result);
	return result;
}




interface ColorGeneratorConfig {
	isDarkTheme: boolean;
	paletteSize: number;
	baseChroma: number;
	baseLightness: number;
	seed: number,
	isShuffling: boolean;
	constantOffset: number;
}

function generateColorPalette({isDarkTheme, paletteSize, baseChroma, baseLightness, constantOffset, isShuffling, seed}: ColorGeneratorConfig) {
	const hueIncrement = 360 / paletteSize;

	const availableColors = [];

	for (let i = 0; i < paletteSize; i++) {
		const hue = i * hueIncrement + constantOffset;

		let chroma = baseChroma;
		let lightness = baseLightness;
		if (isDarkTheme) {
			chroma = Math.round(baseChroma * 1.8);
			lightness = Math.round(baseLightness / 2.5);
		}

		const lchColor = new Color("lch", [lightness, chroma, hue % 360]).toString();
		availableColors.push(lchColor);
	}

	if (!isShuffling) {
		return availableColors;
	}

	const result = [];

	let next = 0;
	const len = availableColors.length;
	while (result.length < len) {
		result.push(availableColors[next]);
		availableColors.splice(next, 1);
		next = Math.round((next + availableColors.length / 3)) % availableColors.length;
	}

	const cut = result.splice(-seed, seed);
	result.splice(0, 0, ...cut);

	return result;
}

let appendingCSSBuffer = [];
function appendCSS(css: string): void {
	appendingCSSBuffer.push(css);
	if (appendingCSSBuffer.length > 1) {
		return;
	}
	// Delay DOM manipulation for next tick
	Promise.resolve().then(() => {
		let styleEl = document.head.querySelector('[colored-tags-style]');
		if (!styleEl) {
			styleEl = document.head
				.createEl("style", {
					type: "text/css",
					attr: {"colored-tags-style": ""},
				});
		}
		styleEl.appendText(appendingCSSBuffer.join('\n'));

		appendingCSSBuffer = [];
	});
}

function removeCSS(): void {
	document.head.querySelectorAll('[colored-tags-style]').forEach((el) => {
		el.remove();
	});
}


class ColoredTagsPluginSettingTab extends PluginSettingTab {
	plugin: ColoredTagsPlugin;

	constructor(app: App, plugin: ColoredTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	renderPalette(paletteEl: Node) {
		paletteEl.empty();
		let palette = this.plugin.palettes.light;
		if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
			palette = this.plugin.palettes.dark;
		}
		palette.forEach((paletteColor) => {
			paletteEl.createEl("div", {attr: {style: `flex: 1; height: 20px; background-color: ${paletteColor}`}});
		});
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const paletteEl = containerEl.createEl("div", {
			cls: "palette",
			attr: {style: `display: flex; align-items: stretch`}
		});
		this.renderPalette(paletteEl);

		new Setting(containerEl)
            .setName('Enable custom colors')
            .setDesc('Ignore other pallet settings and use only custom colors.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableCustomColors)
                .onChange(async (value) => {
                    this.plugin.settings.enableCustomColors = value;
                    await this.plugin.saveSettings();
					this.display();
					this.renderPalette(paletteEl);
                }));

		if(this.plugin.settings.enableCustomColors !== true) {
			new Setting(containerEl)
				.setName('Palette size')
				.setDesc('How many different colors are available.')
				.addSlider(slider =>
					slider.setLimits(8, 32, 8)
						.setValue(this.plugin.settings.palette)
						.onChange(async (value) => {
							slider.showTooltip();
							this.plugin.settings.palette = value;
							await this.plugin.saveSettings();
							this.renderPalette(paletteEl);
						})
				)

			new Setting(containerEl)
				.setName('Palette shift')
				.setDesc('If the colors of some tags don\'t fit, you can shift the palette.')
				.addSlider(slider =>
					slider.setLimits(0, 10, 1)
						.setValue(this.plugin.settings.seed)
						.onChange(async (value) => {
							slider.showTooltip();
							this.plugin.settings.seed = value;
							await this.plugin.saveSettings();
							this.renderPalette(paletteEl);
						})
				)

			new Setting(containerEl)
				.setName('Saturation')
				.addDropdown(dropdown =>
					dropdown.addOption(String(DEFAULT_SETTINGS.chroma), 'Default')
						.addOptions({
							'5': 'Faded',
							'32': 'Moderate',
							'64': 'Vivid',
							'128': 'Excessive',
						})
						.setValue(String(this.plugin.settings.chroma))
						.onChange(async (value) => {
							this.plugin.settings.chroma = Number(value);
							await this.plugin.saveSettings();
							this.renderPalette(paletteEl);
						})
				)

			new Setting(containerEl)
				.setName('Lightness')
				.addDropdown(dropdown =>
					dropdown.addOption(String(DEFAULT_SETTINGS.lightness), 'Default')
						.addOptions({
							'0': 'Dark',
							'32': 'Medium Dark',
							'64': 'Medium',
							'90': 'Light',
							'100': 'Bleach',
						})
						.setValue(String(this.plugin.settings.lightness))
						.onChange(async (value) => {
							this.plugin.settings.lightness = Number(value);
							await this.plugin.saveSettings();
							this.renderPalette(paletteEl);
						})
				)
		}

		if(this.plugin.settings.enableCustomColors === true) {
			new Setting(containerEl)
				.setDesc('Enter your custom colors separated by commas (e.g., #FF5733, #33D2FF).')
				.addText(text => text
					.setValue(this.plugin.settings.customColors ? this.plugin.settings.customColors.join(', ') : '')
					.onChange(async (value) => {
						const colors = value.split(',').map(color => color.trim());
						this.plugin.settings.customColors = colors;
						await this.plugin.saveSettings();
						this.renderPalette(paletteEl);
					})
				);
		}
	}
}
