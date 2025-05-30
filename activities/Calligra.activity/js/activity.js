// Rebase require directory
requirejs.config({
	baseUrl: "lib",
	paths: {
		activity: "../js"
	}
});

// Vue main app
var app = new Vue({
	el: '#app',
	components: {
		'toolbar': Toolbar, 'localization': Localization, 'tutorial': Tutorial,
		'template-viewer': TemplateViewer, 'editor': Editor, 'player': Player,
		'popup': Popup
	},
	data: {
		currentView: TemplateViewer,
		currentLibrary: null,
		currentTemplate: null,
		currentItem: null,
		color: {stroke:'#00000', fill:'#ffffff'},
		l10n: {
			stringWord0: '',
			stringWord1: '',
			stringWord2: '',
			stringWord3: '',
			stringWord4: '',
			stringWord5: '',
			stringWord6: '',
			stringWord7: '',
			stringWord8: '',
			stringWord9: '',
			stringWord10: '',
			stringWord11: '',
			stringWord12: '',
			stringWord13: '',
			stringWord14: ''
		}
	},

	created: function() {
		requirejs(["sugar-web/activity/activity", "sugar-web/env", "activity/palettes/templatepalette"], function(activity, env, templatepalette) {
			// Initialize Sugarizer
			activity.setup();
		});
	},

	mounted: function() {
		// Load last library from Journal
		var vm = this;
		requirejs(["sugar-web/activity/activity", "sugar-web/env"], function(activity, env) {
			env.getEnvironment(function(err, environment) {
					// Use buddy color for background
					env.getEnvironment(function(err, environment) {
						vm.color = environment.user.colorvalue;
						document.getElementById("canvas").style.backgroundColor = vm.color.fill;
					});

				// Load context
				if (environment.objectId) {
					activity.getDatastoreObject().loadAsText(function(error, metadata, data) {
						if (error==null && data!=null) {
							var parsed = JSON.parse(data);
							vm.currentLibrary = parsed.library;
							vm.currentTemplate = parsed.library[parsed.template];
							document.getElementById("template-button").style.backgroundImage = "url(icons/"+vm.currentTemplate.name+".svg)";
							vm.$refs.toolbar.$refs.templatebutton.paletteObject.getPalette().children[0].style.backgroundImage = "url(icons/"+vm.currentTemplate.name+".svg)";
						} else {
							vm.currentLibrary = defaultTemplates;
							vm.currentTemplate = defaultTemplates[0];
						}
					});
				} else {
					vm.currentLibrary = defaultTemplates;
					vm.currentTemplate = defaultTemplates[0];
				}
			});
		});

		// Handle resize
		window.addEventListener("resize", function() {
			vm.onResize();
		});

		// Handle unfull screen buttons (b)
		document.getElementById("unfullscreen-button").addEventListener('click', function() {
			vm.unfullscreen();
		});
	},

	methods: {

		localized: function() {
			// Initialize word list
			var vm = this;
			requirejs(["sugar-web/env"], function(env) {
				env.getEnvironment(function(err, environment) {
					var iuser = environment.user.name;
					var images = [];
					var user = '';
					for (let i = 0 ; i < iuser.length ; i++) {
						if (vm.validateText(iuser[i])) {
							user += iuser[i];
						}
					}
					if (user.length) {
						images.push({text: user});
					}
					for (let i = 0 ; i < 15 ; i++) {
						images.push({text: window.l10n.get("Word"+i)});
					}
					defaultTemplates[2].images = images;
				});
			});
			this.$refs.toolbar.localized(this.$refs.localization);
			this.$refs.tutorial.localized(this.$refs.localization);
		},

		displayTemplateView: function() {
			var vm = this;
			vm.$refs.toolbar.$refs.lines.isDisabled = true;
			vm.$refs.toolbar.$refs.zoombutton.isDisabled = true;
			vm.currentView = TemplateViewer;
			vm.$refs.toolbar.$refs.insertimage.isDisabled = (!vm.$refs.view.editMode || (vm.currentTemplate && vm.currentTemplate.name == "template-word"));
			vm.$refs.toolbar.$refs.inserttext.isDisabled = (!vm.$refs.view.editMode || (vm.currentTemplate && vm.currentTemplate.name != "template-word"));
			document.getElementById("canvas").style.backgroundColor = vm.color.fill;
			document.getElementById("settings-button").style.backgroundImage = vm.$refs.view.editMode?"url(icons/play.svg)":"url(icons/settings.svg)";
		},

		// Handle fullscreen mode
		fullscreen: function() {
			var vm = this;
			document.getElementById("main-toolbar").style.opacity = 0;
			document.getElementById("canvas").style.top = "0px";
			document.getElementById("unfullscreen-button").style.visibility = "visible";
			if (vm.currentView === Player) {
				vm.$refs.view.doFullscreen(true);
			}
		},
		unfullscreen: function() {
			var vm = this;
			document.getElementById("main-toolbar").style.opacity = 1;
			document.getElementById("canvas").style.top = "55px";
			document.getElementById("unfullscreen-button").style.visibility = "hidden";
			if (vm.currentView === Player) {
				vm.$refs.view.doFullscreen(false);
			}
		},


		// Handle events
		onTemplateSelected: function(template) {
			var vm = this;
			for (var i = 0; i < vm.currentLibrary.length ; i++) { // Save change
				if (vm.currentTemplate == vm.currentLibrary[i]) {
					vm.currentLibrary[i] = vm.currentTemplate;
					break;
				}
			}
			vm.currentTemplate=vm.currentLibrary[template.index];
			vm.displayTemplateView();
		},

		onItemSelected: function(item, editMode) {
			var vm = this;
			if (vm.currentView === TemplateViewer) {
				// Remove item
				if (editMode) {
					const images = vm.currentTemplate.images.map(item=>{
						return {
							...item,
							visible: item.visible !== undefined ? item.visible : true,
							delete: item.delete !== undefined ? item.delete : false
						}
					});

					if(vm.currentTemplate.name === 'template-word'){
					var index = -1;
					for (var i = 0 ; i < vm.currentTemplate.images.length ; i++) {
						if (vm.currentTemplate.images[i] == item) {
							index = i;
							break; 
						}
					}
					vm.currentTemplate.images.splice(index, 1);
					return;
					}
					var index = -1;
					for (var i = 0 ; i < vm.currentTemplate.images.length ; i++) {
						if (images[i].image == item.image) {
							index = i;
							break;
						}
					}
					images[index].delete = true;
					vm.currentTemplate.images = images;
					return;
				}

				// Display item
				vm.$refs.toolbar.$refs.lines.isDisabled = false;
				vm.$refs.toolbar.$refs.zoombutton.isDisabled = false;
				vm.$refs.toolbar.$refs.insertimage.isDisabled = true;
				vm.$refs.toolbar.$refs.inserttext.isDisabled = true;
				vm.currentView = Player;
				vm.currentItem = item;
				document.getElementById("canvas").style.backgroundColor = "#ffffff";
			}
		},
		nextItem: function (item) {
			// returns the next letter when Try Next button is clicked
			var vm = this;
			var index = -1;
			for (var i = 0 ; i < vm.currentTemplate.images.length ; i++) {
				if (item.image && vm.currentTemplate.images[i].image == item.image ||
					item.text && vm.currentTemplate.images[i].text == item.text) {
					index = i;
					break;
				}
			}
			index++;
			if (index === vm.currentTemplate.images.length) {
				index = 0;
			}
			var next = vm.currentTemplate.images[index];
			if (next.visible === false) {
				return vm.nextItem(next);
			}
			return next;

		},

		onZoom: function(item) {
			var vm = this;
			if (vm.currentView === Player) {
				vm.$refs.view.doZoom(item.detail);
			}
		},

		onSettings: function() {
			var vm = this;
			if (vm.currentView === TemplateViewer) {
				vm.$refs.view.editMode = !vm.$refs.view.editMode;
				vm.$refs.toolbar.$refs.insertimage.isDisabled = (!vm.$refs.view.editMode || (vm.currentTemplate && vm.currentTemplate.name == "template-word"));
				vm.$refs.toolbar.$refs.inserttext.isDisabled = (!vm.$refs.view.editMode || (vm.currentTemplate && vm.currentTemplate.name != "template-word"));
				document.getElementById("settings-button").style.backgroundImage = vm.$refs.view.editMode?"url(icons/play.svg)":"url(icons/settings.svg)";
			} else if (vm.currentView === Player) {
				document.getElementById("settings-button").style.backgroundImage = "url(icons/play.svg)";
				if (vm.currentItem.image) {
					vm.currentView = Editor;
				} else {
					vm.showTypeTextPopup(
						vm.currentItem.text,
						function(text) {
							if (text && text.length) {
								vm.currentItem.text = text;
								var that = vm.$refs.view;
								that.initComponent(function() {
									that.onLoad();
									that.startDemoMode();
								});
							}
							document.getElementById("settings-button").style.backgroundImage = "url(icons/settings.svg)";
						}
					);
				}

			} else {
				vm.currentView = Player;
				document.getElementById("settings-button").style.backgroundImage = "url(icons/settings.svg)";
			}
		},

		onInsertImage: function() {
			var vm = this;
			if (vm.currentView !== TemplateViewer || !vm.$refs.view.editMode) {
				return;
			}
			requirejs(["sugar-web/datastore", "sugar-web/graphics/journalchooser"], function(datastore, journalchooser) {
				setTimeout(function() {
					journalchooser.show(function(entry) {
						if (!entry) {
							return;
						}
						var dataentry = new datastore.DatastoreObject(entry.objectId);
						dataentry.loadAsText(function(err, metadata, data) {
							vm.currentTemplate.images.push({image: data});
						});
					}, { mimetype: 'image/png' }, { mimetype: 'image/jpeg' });
				}, 0);
			});
		},

		onInsertText: function() {
			var vm = this;
			vm.showTypeTextPopup(
				window.l10n.get("TextDefault"),
				function(text) {
					if (text && text.length) {
						vm.currentTemplate.images.push({text: text});
					}
				}
			);
		},

		onLines: function() {
			var vm = this;
			vm.$refs.toolbar.$refs.lines.isActive = !vm.$refs.toolbar.$refs.lines.isActive;
			if (vm.currentView === Player) {
				vm.$refs.view.draw();
			}
		},

		onResize: function() {
			var vm = this;
			if (vm.currentView === Player) {
				vm.$refs.view.computeSize();
			}
		},

		onHelp: function() {
			var vm = this;
			var options = {};
			options.currentView = vm.currentView;
			options.editMode = vm.$refs.view.editMode || vm.currentView === Editor;
			options.templatebutton = vm.$refs.toolbar.$refs.templatebutton.$el;
			options.fullscreenbutton = vm.$refs.toolbar.$refs.fullscreen.$el;
			options.settingsbutton = vm.$refs.toolbar.$refs.settings.$el;
			if (vm.currentView === TemplateViewer) {
				options.insertimagebutton = (vm.currentTemplate.name!="template-word"?vm.$refs.toolbar.$refs.insertimage.$el:vm.$refs.toolbar.$refs.inserttext.$el);
				if (vm.currentTemplate && vm.currentTemplate.images && vm.currentTemplate.images[0]) {
					options.item = vm.$refs.view.$refs.item0[0].$el;
				}
			} else {
				options.linesbutton = vm.$refs.toolbar.$refs.lines.$el;
				options.zoombutton = vm.$refs.toolbar.$refs.zoombutton.$el;
				options.backbutton = document.getElementById("back");
				options.restartbutton = document.getElementById("player-restart");
				options.nextbutton = document.getElementById("player-next-letter");
				options.editoraddbutton = document.getElementById("editor-add");
				options.editorremovebutton = document.getElementById("editor-remove");
				options.editoraddpathbutton = document.getElementById("editor-addpath");
				options.editorremovepathbutton = document.getElementById("editor-removepath");
			}
			this.$refs.tutorial.show(options);
		},

		onStop: function() {
			// Save current library in Journal on Stop
			var vm = this;
			requirejs(["sugar-web/activity/activity"], function(activity) {
				console.log("writing...");
				requirejs(["sugar-web/activity/activity"], function(activity) {
					console.log("writing...");
					var i = 0;
					for (; i < vm.currentLibrary.length ; i++) { // Save change
						if (vm.currentTemplate == vm.currentLibrary[i]) {
							vm.currentLibrary[i] = vm.currentTemplate;
							break;
						}
					}
					var context = {
						library: vm.currentLibrary,
						template: i
					};
					var jsonData = JSON.stringify(context);
					activity.getDatastoreObject().setDataAsText(jsonData);
					activity.getDatastoreObject().save(function(error) {
						if (error === null) {
							console.log("write done.");
						} else {
							console.log("write failed.");
						}
					});
				});
			});
		},

		// Handle type text popup
		showTypeTextPopup: function(defaultText, callback) {
			var titleOk =  window.l10n.get("Ok"),
				titleCancel =  window.l10n.get("Cancel"),
				titleSettings =  window.l10n.get("TextTitle");
			this.$refs.inserttextpopup.show({
				data: {
					defaultText: defaultText,
					callback: callback
				},
				content: `
					<div id='popup-toolbar' class='toolbar' style='padding: 0'>
						<button class='toolbutton pull-right' id='popup-ok-button' title='`+titleOk+`' style='outline:none;background-image: url(lib/sugar-web/graphics/icons/actions/dialog-ok.svg)'></button>
						<button class='toolbutton pull-right' id='popup-cancel-button' title='`+titleCancel+`' style='outline:none;background-image: url(lib/sugar-web/graphics/icons/actions/dialog-cancel.svg)'></button>
						<div style='position: absolute; top: 20px; left: 60px;'>`+titleSettings+`</div>
					</div>
					<div id='popup-container' style='width: 100%; overflow:auto'>
						<input id='newitem-text' class='popup-input'/>
					</div>`,
				closeButton: false,
				modalStyles: {
					backgroundColor: "white",
					height: "170px",
					width: "420px",
					maxWidth: "90%"
				}
			});
		},

		insertPopupShown: function() {
			var vm = this;
			document.getElementById('popup-ok-button').addEventListener('click', function() {
				vm.$refs.inserttextpopup.close(true);
			});
			document.getElementById('popup-cancel-button').addEventListener('click', function() {
				vm.$refs.inserttextpopup.close();
			});
			let input = document.getElementById('newitem-text')
			input.value = vm.$refs.inserttextpopup.data.defaultText;
			input.setSelectionRange(0, input.value.length);
			input.focus();
			var setInputFilter = function(textbox, inputFilter) {
				// Restricts input to alphanumeric characters see https://stackoverflow.com/questions/469357/html-text-input-allow-only-numeric-input
				["input", "keydown", "keyup", "mousedown", "mouseup", "select", "contextmenu", "drop"].forEach(function(event) {
					textbox.addEventListener(event, function() {
						if (inputFilter(this.value)) {
							this.oldValue = this.value;
							this.oldSelectionStart = this.selectionStart;
							this.oldSelectionEnd = this.selectionEnd;
						} else if (this.hasOwnProperty("oldValue")) {
							this.value = this.oldValue;
							this.setSelectionRange(this.oldSelectionStart, this.oldSelectionEnd);
						} else {
							this.value = "";
						}
					});
				});
			};
			setInputFilter(input, function(value) {
				return vm.validateText(value);
			});
		},
		insertPopupClosed: function(result) {
			if (result) {
				this.$refs.inserttextpopup.data.callback(document.getElementById('newitem-text').value);
			} else {
				this.$refs.inserttextpopup.data.callback(null);
			}
			this.$refs.inserttextpopup.destroy();
		},
		validateText: function(value) {
			return /^[A-Za-z]*$/.test(value);
		}
	}
});
