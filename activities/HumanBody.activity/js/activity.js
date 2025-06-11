define([
	"sugar-web/activity/activity",
	"sugar-web/env",
	"activity/palettes/colorpalettefill",
	"activity/palettes/zoompalette",
	"activity/palettes/modelpalette",
	"activity/palettes/settingspalette",
	"sugar-web/graphics/presencepalette",
	"l10n",
], function (
	activity,
	env,
	colorpaletteFill,
	zoompalette,
	modelpalette,
	settingspalette,
	presencepalette,
	l10n,
) {
	requirejs(["domReady!"], function (doc) {
		activity.setup();
		let fillColor = null;
		let doctorMode = false;
		let currentBodyPartIndex = 0;
		let bodyParts = [];
		let modal = null;
		let partsColored = [];
		let username = null;
		let players = [];
		let isHost = false;
		let presenceCorrectIndex = 0;
		let presenceIndex = 0;
		let ifDoctorHost = false;
		let firstAnswer = true;
		let numModals = 0;

		// Model state management
		let currentModel = null;

		// Default model
		let currentModelName = "body"; 

		const availableModels = {
			skeleton: {
				modelPath: "models/skeleton/skeleton.gltf",
				name: "skeleton",
				position: { x: 0, y: -6, z: 0 },
				scale: { x: 4, y: 4, z: 4 }
			},
			body: {
				modelPath: "models/human/human.gltf",
				name: "human-body",
				position: { x: 0, y: 2, z: 0 },
				scale: { x: 1.2, y: 1.2, z: 1.2 }
			},
			organs: {
				modelPath: "models/organs/organs.gltf",
				name: "organs",
				position: { x: 0, y: -1, z: 0 },
				scale: { x: 1, y: 1, z: 1 }
			}
		};

		var paletteColorFill = new colorpaletteFill.ColorPalette(
			document.getElementById("color-button-fill"),
			undefined
		);

		var paletteSettings = new settingspalette.SettingsPalette(
			document.getElementById("settings-button"),
			undefined
		);

		var paletteModel = new modelpalette.ModelPalette(
			document.getElementById("model-button"),
			undefined
		);

		document
			.getElementById("stop-button")
			.addEventListener("click", function (event) {
				console.log("writing...");
				var jsonData = JSON.stringify(partsColored);
				activity.getDatastoreObject().setDataAsText(jsonData);
				activity.getDatastoreObject().save(function (error) {
					if (error === null) {
						console.log("write done.");
					} else {
						console.log("write failed.");
					}
				});
			});

		// Store the environment
		let currentenv;
		env.getEnvironment(function (err, environment) {
			currentenv = environment;

			// Set current language to Sugarizer
			var defaultLanguage = 
						(typeof chrome != 'undefined' && chrome.app && chrome.app.runtime) 
						? chrome.i18n.getUILanguage() 
						: navigator.language;
			var language = environment.user ? environment.user.language : defaultLanguage;
			l10n.init(language);

			// Process localize event
			window.addEventListener("localized", function () {
				// Update mode text based on current mode
				updateModeText();
			}, false);

			username = environment.user.name;

			// Load from datastore
			if (!environment.objectId) {
				console.log("New instance");
				currentModelName = "body";
				loadModel({
					...availableModels.body,
					callback: (loadedModel) => {
						currentModel = loadedModel; // Assign to currentModel for tracking
					}
				});
			} else {
				activity
					.getDatastoreObject()
					.loadAsText(function (error, metadata, data) {
						if (error == null && data != null) {
							partsColored = JSON.parse(data);
							currentModelName = "body";
							loadModel({
								...availableModels.body,
								callback: (loadedModel) => {
									currentModel = loadedModel; // Assign to currentModel for tracking
								}
							});
						}
					});
			}

			fillColor = environment.user.colorvalue.fill || fillColor;

			document.getElementById("color-button-fill").style.backgroundColor = fillColor;

			if (environment.sharedId) {
				console.log("Shared instance");
				presence = activity.getPresenceObject(function (
					error,
					network
				) {
					network.onDataReceived(onNetworkDataReceived);
				});
			}
		});

		// General function to load models, can be reused for different models
		function loadModel(options) {
			const {
				modelPath,
				name,
				position = { x: 0, y: 0, z: 0 },
				scale = { x: 1, y: 1, z: 1 },
				color = null,
				callback = null
			} = options;

			loader.load(
				modelPath,
				function (gltf) {
					const model = gltf.scene;
					model.name = name;

					// Apply position
					model.position.set(position.x, position.y, position.z);
					model.scale.set(scale.x, scale.y, scale.z);

					let meshCount = 0;
					model.traverse((node) => {
						if (node.isMesh) {
							meshCount++;

							// Ensure geometry is properly set up
							const geometry = node.geometry;

							if (!geometry.boundingBox) {
								geometry.computeBoundingBox();
							}
							if (!geometry.boundingSphere) {
								geometry.computeBoundingSphere();
							}
							if (!geometry.attributes.normal) {
								geometry.computeVertexNormals();
							}

							// Force geometry to be non-indexed for better raycasting
							if (geometry.index) {
								const nonIndexedGeometry = geometry.toNonIndexed();
								node.geometry = nonIndexedGeometry;
								nonIndexedGeometry.computeBoundingBox();
								nonIndexedGeometry.computeBoundingSphere();
							}

							// Set up material
							node.userData.originalMaterial = node.material.clone();

							if (!node.material.isMeshStandardMaterial) {
								node.material = new THREE.MeshStandardMaterial({
									color: node.material.color || new THREE.Color(0xe7e7e7),
									side: THREE.DoubleSide,
									transparent: false,
									opacity: 1.0,
									depthTest: true,
									depthWrite: true
								});
							}

							// Apply saved colors
							if (name === "skeleton") {
								const part = partsColored.find(
									([partName, partColor]) => partName === node.name
								);
								if (part) {
									const [, partColor] = part;
									if (partColor !== "#000000" && partColor !== "#ffffff") {
										node.material = new THREE.MeshStandardMaterial({
											color: new THREE.Color(partColor),
											side: THREE.DoubleSide,
											transparent: false,
											opacity: 1.0,
											depthTest: true,
											depthWrite: true
										});
									}
								}
							}

							// Ensure visibility and proper setup
							node.visible = true;
							node.castShadow = true;
							node.receiveShadow = true;
							node.frustumCulled = false;

							// Force matrix update
							node.updateMatrix();
							node.updateMatrixWorld(true);
						}
					});

					// Update model matrix
					model.updateMatrix();
					model.updateMatrixWorld(true);

					scene.add(model);

					if (callback) callback(model);
				},
				function (xhr) {
					console.log((xhr.loaded / xhr.total) * 100 + "% loaded");
				},
				function (error) {
					console.log("An error happened while loading", name);
					console.log(error);
				}
			);
		}

		function removeCurrentModel() {
			if (currentModel) {
				scene.remove(currentModel);

				// Clean up model resources
				currentModel.traverse((child) => {
					if (child.isMesh) {
						if (child.geometry) {
							child.geometry.dispose();
						}
						if (child.material) {
							if (Array.isArray(child.material)) {
								child.material.forEach(material => material.dispose());
							} else {
								child.material.dispose();
							}
						}
					}
				});

				currentModel = null;
			}
		}

		function switchModel(modelKey) {
			if (!availableModels[modelKey]) {
				console.error(`Model ${modelKey} not found`);
				return;
			}

			if (currentModelName === modelKey) {
				console.log(`Model ${modelKey} is already loaded`);
				return;
			}

			// Remove current model
			removeCurrentModel();

			// Update current model name
			currentModelName = modelKey;

			// Update toolbar icon
			const modelButton = document.getElementById('model-button');
			modelButton.classList.remove('skeleton-icon', 'body-icon', 'organs-icon');
			modelButton.classList.add(`${modelKey}-icon`);

			// Load new model
			const modelConfig = availableModels[modelKey];
			loadModel({
				...modelConfig,
				callback: (loadedModel) => {
					currentModel = loadedModel;
					console.log(`Successfully loaded ${modelKey} model`);
				}
			});
		}

		document.addEventListener('model-selected', function (event) {
			const selectedModel = event.detail.model;
			console.log('Model selected:', selectedModel);
			switchModel(selectedModel);
		});

		document.addEventListener('mode-selected', function (event) {
			const selectedMode = event.detail.mode;
			currentModeIndex = selectedMode;
			updateModeText();
		});

		// Link presence palette
		var presence = null;
		var palette = new presencepalette.PresencePalette(
			document.getElementById("network-button"),
			undefined
		);
		palette.addEventListener("shared", function () {
			palette.popDown();
			console.log("Want to share");
			presence = activity.getPresenceObject(function (error, network) {
				if (error) {
					console.log("Sharing error");
					return;
				}
				network.createSharedActivity(
					"org.sugarlabs.HumanBody",
					function (groupId) {
						console.log("Activity shared");
						isHost = true;
					}
				);
				network.onDataReceived(onNetworkDataReceived);
				network.onSharedActivityUserChanged(onNetworkUserChanged);
			});
		});

		var onNetworkDataReceived = function (msg) {
			if (presence.getUserInfo().networkId === msg.user.networkId) {
				return;
			}
			if (msg.action == "init") {
				partsColored = msg.content[0];
				players = msg.content[1];
				console.log(partsColored);
				// Load the human body model
				currentModelName = "body";
				loadModel({
					...availableModels.body,
					callback: (loadedModel) => {
						currentModel = loadedModel; // Assign to currentModel for tracking
					}
				});
			}

			if (msg.action == "nextQuestion") {
				if (bodyParts[msg.content]) {
					presenceCorrectIndex = msg.content;
					showModal(l10n.get("FindThe", { name: l10n.get(bodyParts[currentBodyPartIndex].name) }));
				}
			}

			if (msg.action == "update") {
				players = msg.content;
				showLeaderboard();
			}

			if (msg.action == "answer") {
				console.log("answering")
				if (!ifDoctorHost || !firstAnswer) {
					return;
				}
				let target = players.findIndex(
					(innerArray) => innerArray[0] === msg.user.name
				);
				players[target][1]++;
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: "update",
					content: players,
				});
				console.log(msg.user.name + " was the fastest");
				console.log(players);
				showLeaderboard();
				presenceIndex++;
				// startDoctorModePresence();
			}

			if (msg.action == "startDoctor") {
				showLeaderboard();
				isPaintActive = false;
				isLearnActive = false;
				isTourActive = false;
				isDoctorActive = true;
			}
		};

		var onNetworkUserChanged = function (msg) {
			players.push([msg.user.name, 0]);
			if (isDoctorActive) {
				showLeaderboard();
			}
			if (isHost) {
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: "init",
					content: [partsColored, players],
				});
			}

			if (isDoctorActive) {
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: "startDoctor",
					content: players,
				});
				ifDoctorHost = true;
				startDoctorModePresence();
			}
		};

		// Mode variables to track which mode is active
		let isPaintActive = true;
		let isTourActive = false;
		let isDoctorActive = false;

		// Array of modes
		const modes = ["Paint", "Tour", "Doctor"];
		let currentModeIndex = 0;

		// DOM elements
		const modeTextElem = document.getElementById("mode-text");
		const leftArrow = document.getElementById("left-arrow");
		const rightArrow = document.getElementById("right-arrow");

		// Function to handle entering Tour mode
		function startTourMode() {
			let tourIndex = 0; // Start with the first body part in the list
			let previousMesh = null;

			function tourNextPart() {
				if (tourIndex >= bodyParts.length || !isTourActive) {
					// Restore previous mesh color before stopping
					if (previousMesh) {
						previousMesh.material = previousMesh.userData.originalMaterial.clone();
					}
					stopTourMode(); // Stop the tour if all parts have been shown
					return;
				}

				const part = bodyParts[tourIndex];
				const position = part.position; // Retrieve the position of the body part

				// Find the mesh for the current body part
				const currentMesh = currentModel.getObjectByName(part.mesh);

				// Restore previous mesh color
				if (previousMesh) {
					previousMesh.material = previousMesh.userData.originalMaterial.clone();
				}

				// Highlight current mesh
				if (currentMesh) {
					// Store original material if not already stored
					if (!currentMesh.userData.originalMaterial) {
						currentMesh.userData.originalMaterial = currentMesh.material.clone();
					}

					// Apply highlight color
					currentMesh.material = new THREE.MeshStandardMaterial({
						color: new THREE.Color("#ffff00"), // Yellow highlight
						side: THREE.DoubleSide,
						transparent: true,
						opacity: 0.8,
						depthTest: true,
						depthWrite: true,
						emissive: new THREE.Color("#ffff00"),
						emissiveIntensity: 0.2
					});

					previousMesh = currentMesh;
				}

				// Zoom to the body part's position
				camera.position.set(position[0], position[1], position[2] + 5); // Adjust the zoom offset as necessary
				camera.lookAt(position[0], position[1], position[2]);
				camera.updateProjectionMatrix();

				// Display the name of the part using the modal
				showModal(l10n.get(part.name));

				tourIndex++;

				// Set a timeout to move to the next part after a delay (e.g., 3 seconds)
				setTimeout(tourNextPart, 3000);
			}

			tourNextPart(); // Start the tour
		}

		// Function to handle exiting Tour mode
		function stopTourMode() {
			camera.position.set(0, 10, 20);
			camera.lookAt(0, 0, 0);
		}

		// Update the mode text based on the current mode index
		function updateModeText() {
			// If switching from Tour mode, stop it
			if (isTourActive && currentModeIndex !== 2) {
				stopTourMode();
			}

			// If switching from Doctor mode, stop it
			if (isDoctorActive && currentModeIndex !== 3) {
				stopDoctorMode();
			}

			const modeKey = modes[currentModeIndex];

			// Check if modeTextElem exists before setting textContent
			if (modeTextElem) {
				modeTextElem.textContent = l10n.get(modeKey);
			}

			// Update mode tracking variables
			isPaintActive = currentModeIndex === 0;
			isTourActive = currentModeIndex === 2;
			isDoctorActive = currentModeIndex === 3;

			// If switching to Tour mode, start it
			if (isTourActive) {
				startTourMode();
			}

			// If switching to Doctor mode, start it
			if (isDoctorActive) {
				if (presence) {
					showLeaderboard();

					presence.sendMessage(presence.getSharedInfo().id, {
						user: presence.getUserInfo(),
						action: "startDoctor",
						content: players,
					});
					ifDoctorHost = true;
					startDoctorModePresence();
				} else {
					console.log("starting doctor mode");
					startDoctorMode();
				}
			}
		}

		function showLeaderboard() {
			console.log("running show leaderboard");
			var leaderboard = document.getElementById("leaderboard");
			leaderboard.style.display = "block";
			let playerScores = players;
			var tableBody = document.querySelector(".leaderboard tbody");

			tableBody.innerHTML = "";
			for (var i = 0; i < playerScores.length; i++) {
				var playerName = playerScores[i][0]; // Get player name
				var playerScore = playerScores[i][1]; // Get player score

				// Create a new row
				var tableBody = document.querySelector(".leaderboard tbody");
				var newRow = tableBody.insertRow();

				// Create new cells for player name and score
				var nameCell = newRow.insertCell(0);
				var scoreCell = newRow.insertCell(1);

				// Set the text content for the cells
				nameCell.textContent = playerName;
				scoreCell.textContent = playerScore;
			}
		}

		// Initialize the mode text
		updateModeText();

		document.getElementById("color-button-fill").style.backgroundColor =
			fillColor;

		var paletteZoom = new zoompalette.ZoomPalette(
			document.getElementById("zoom-button"),
			undefined
		);

		const camera = new THREE.PerspectiveCamera(
			45,
			window.innerWidth / window.innerHeight,
			0.1,
			1000
		);

		const goRightButton = document.querySelector("#right-button");
		const goLeftButton = document.querySelector("#left-button");
		const goUpButton = document.querySelector("#up-button");
		const goDownButton = document.querySelector("#down-button");

		// Handles the rotation of the board through the arrow buttons
		goRightButton.addEventListener("click", function (event) {
			orbit.rotateRight();
			event.stopPropagation();
		});

		goLeftButton.addEventListener("click", function (event) {
			orbit.rotateLeft();
			event.stopPropagation();
		});
		goUpButton.addEventListener("click", function (event) {
			orbit.rotateUp();
			event.stopPropagation();
		});
		goDownButton.addEventListener("click", function (event) {
			orbit.rotateDown();
			event.stopPropagation();
		});

		const evt = new Event("wheel", { bubbles: true, cancelable: true });

		const zoomInButton = document.getElementById("zoom-in-button");
		const zoomOutButton = document.getElementById("zoom-out-button");
		const zoomEqualButton = document.getElementById("zoom-equal-button");
		const zoomToButton = document.getElementById("zoom-to-button");

		const zoomFunction = (zoomType, targetFov) => (e) => {
			let fov = getFov();
			if (zoomType === "click") {
				camera.fov = targetFov;
			} else {
				camera.fov = clickZoom(fov, zoomType);
			}
			camera.updateProjectionMatrix();
			e.stopPropagation();
		};


		const clickZoom = (value, zoomType) => {
			if (value >= 5 && zoomType === "zoomIn") {
				return value - 5;
			} else if (value <= 75 && zoomType === "zoomOut") {
				return value + 5;
			} else {
				return value;
			}
		};

		const getFov = () => {
			return Math.floor( (2 * Math.atan(camera.getFilmHeight() / 2 / camera.getFocalLength()) * 180)/Math.PI );
		};

		const fov = getFov();
		camera.updateProjectionMatrix();

		zoomInButton.addEventListener("click", zoomFunction("zoomIn"));
		zoomOutButton.addEventListener("click", zoomFunction("zoomOut"));
		zoomEqualButton.addEventListener("click", zoomFunction("click", 29));
		zoomToButton.addEventListener("click", zoomFunction("click", 35));

		// JSON file containing the body parts and their mesh names
		fetch("./js/bodyParts.json")
			.then((response) => response.json())
			.then((data) => {
				bodyParts = data;
				for (let i = 0; i < bodyParts.length; i++) {
					partsColored.push([bodyParts[i].name, "#000000"]);
				}
			})
			.catch((error) => {
				console.error("Error fetching bodyParts.json:", error);
			});

		function startDoctorMode() {
			currentBodyPartIndex = 0;
			if (bodyParts[currentBodyPartIndex]) {
				showModal(l10n.get("FindThe", { name: bodyParts[currentBodyPartIndex].name }));
			}
		}

		function startDoctorModePresence() {
			presence.sendMessage(presence.getSharedInfo().id, {
				user: presence.getUserInfo(),
				action: "nextQuestion",
				content: presenceIndex,
			});
			presenceCorrectIndex = presenceIndex;
			if (bodyParts[presenceIndex]) {
				showModal(l10n.get("FindThe", { name: bodyParts[presenceIndex].name }));
			} else {
				showModal(l10n.get("GameOverAll"));
			}
		}

		function stopDoctorMode() {
			if (modal) {
				document.body.removeChild(modal);
				modal = null;
			}
		}

		function showModal(text) {
			// Check if a modal is already displayed
			let existingModal = document.querySelector('.custom-modal');
			if (existingModal) {
				// If a modal exists, remove it before showing a new one
				existingModal.remove();
			}

			const modal = document.createElement("div");
			modal.className = "custom-modal";

			// Style the modal
			modal.style.position = "absolute";
			modal.style.top = "50%";
			modal.style.left = "50%";
			modal.style.transform = "translate(-50%, -50%)";
			modal.style.backgroundColor = "#f9f9f9"; // Light grey background for a softer look
			modal.style.padding = "30px"; // Increase padding for a larger modal
			modal.style.border = "3px solid #007bff"; // Blue border for a pop of color
			modal.style.borderRadius = "8px"; // Rounded corners for a smoother appearance
			modal.style.boxShadow = "0 4px 8px rgba(0, 0, 0, 0.2)"; // Add a shadow for depth
			modal.style.zIndex = "1000";
			modal.style.textAlign = "center"; // Center the text inside the modal

			// Style the text inside the modal
			modal.style.fontSize = "18px"; // Larger text size
			modal.style.fontWeight = "bold"; // Bold text
			modal.style.color = "#333"; // Darker text color for better contrast

			modal.innerHTML = text;
			numModals++;
			// if (numModals > 1) {
			//     console.log("have modals already")
			//     modal.style.top = "30%"
			// }
			document.body.appendChild(modal);

			// Make the modal disappear after 1.5 seconds
			setTimeout(() => {
				if (modal && modal.parentNode === document.body) {
					document.body.removeChild(modal);
					numModals--;
				}
			}, 1500);
		}

		const redSliderFill = document.getElementById("red-slider-fill");
		const greenSliderFill = document.getElementById("green-slider-fill");
		const blueSliderFill = document.getElementById("blue-slider-fill");

		let sliderColorFill = { r: 0, g: 0, b: 0 };

		function rgbToHex(r, g, b) {
			return (
				"#" +
				((1 << 24) + (r << 16) + (g << 8) + b)
					.toString(16)
					.slice(1)
					.toUpperCase()
			);
		}

		function hexToRgb(hex) {
			let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
			return result
				? {
						r: parseInt(result[1], 16),
						g: parseInt(result[2], 16),
						b: parseInt(result[3], 16),
				  }
				: null;
		}

		function updateColorDisplayFill() {
			const hexColor = rgbToHex(
				sliderColorFill.r,
				sliderColorFill.g,
				sliderColorFill.b
			);
			fillColor = hexColor;
			document.getElementById("color-button-fill").style.backgroundColor =
				fillColor;
		}

		function updateSlidersFill(color) {
			const rgb = hexToRgb(color);
			redSliderFill.value = rgb.r;
			greenSliderFill.value = rgb.g;
			blueSliderFill.value = rgb.b;
		}

		function handleSliderChangeFill() {
			sliderColorFill = {
				r: parseInt(redSliderFill.value),
				g: parseInt(greenSliderFill.value),
				b: parseInt(blueSliderFill.value),
			};
			updateColorDisplayFill();
		}

		redSliderFill.addEventListener("input", handleSliderChangeFill);
		greenSliderFill.addEventListener("input", handleSliderChangeFill);
		blueSliderFill.addEventListener("input", handleSliderChangeFill);

		document.addEventListener("color-selected-fill", function (event) {
			const selectedColorFill = event.detail.color;
			fillColor = selectedColorFill;
			document.getElementById("color-button-fill").style.backgroundColor =
				fillColor;
			updateSlidersFill(selectedColorFill);
		});
		const renderer = new THREE.WebGLRenderer({
			antialias: true,
			alpha: true,
			logarithmicDepthBuffer: true
		});
		renderer.shadowMap.enabled = true;
		renderer.setSize(window.innerWidth, window.innerHeight);
		const canvas = document.getElementById("canvas");
		canvas.appendChild(renderer.domElement);
		const scene = new THREE.Scene();
		scene.background = new THREE.Color("#1a1a1a");

		// Restore all lights
		const light = new THREE.DirectionalLight(0xffffff, 1);
		light.castShadow = true;
		const leftLight = new THREE.DirectionalLight(0xffffff, 1);
		leftLight.castShadow = true;
		const rightLight = new THREE.DirectionalLight(0xffffff, 1);
		rightLight.castShadow = true;
		const backLight = new THREE.DirectionalLight(0xffffff, 1);
		const bottomLight = new THREE.DirectionalLight(0xffffff, 1);
		const topLight = new THREE.DirectionalLight(0xffffff, 1);
		topLight.castShadow = true;
		leftLight.position.set(-30, 20, -30);
		rightLight.position.set(30, 20, -30);
		backLight.position.set(0, 20, 30);
		light.position.set(0, 20, -30);
		bottomLight.position.set(0, -20, -30);
		topLight.position.set(0, 10, 0);
		scene.add(backLight);
		scene.add(rightLight);
		scene.add(leftLight);
		scene.add(light);
		scene.add(bottomLight);
		scene.add(topLight);

		const ambientLight = new THREE.AmbientLight(0x222222); // Soft ambient lighting
		scene.add(ambientLight);

		camera.position.set(0, 10, 20);
		camera.lookAt(0, 0, 0);

		const orbit = new OrbitControls.OrbitControls(
			camera,
			renderer.domElement
		);
		orbit.update();
		orbit.listenToKeyEvents(document.querySelector("body"));

		const loader = new THREE.GLTFLoader();
		let skeleton;

		if (presence == null) {
			switchModel('body');
		}

		function setModelColor(model, color) {
			model.traverse((node) => {
				if (node.isMesh) {
					if (node.material) {
						node.material.color.set(color);
					}
				}
			});
		}

		const raycaster = new THREE.Raycaster();
		const mouse = new THREE.Vector2();

		raycaster.near = camera.near;
		raycaster.far = camera.far;

		// Set raycaster parameters for better intersection detection
		raycaster.params.Points.threshold = 0.1;
		raycaster.params.Line.threshold = 0.1;

		function handleIntersection(intersect) {
			const point = intersect.point;
			const clickedObject = intersect.object;

			if (isPaintActive) {
				handlePaintMode(clickedObject);
			} else if (isDoctorActive) {
				handleDoctorMode(clickedObject);
			}
		}

		function getClicked3DPoint() {
			mouse.x =
				((evt.clientX - canvasPosition.left) / canvas.width) * 2 - 1;
			mouse.y =
				-((evt.clientY - canvasPosition.top) / canvas.height) * 2 + 1;

			rayCaster.setFromCamera(mousePosition, camera);
			var intersects = rayCaster.intersectObjects(
				scene.getObjectByName("skeleton").children,
				true
			);

			if (intersects.length > 0) console.log(intersects[0].point);
		}

		function showPaintModal(bodyPartName) {
			// Check if a paint modal is already displayed and remove it
			let existingPaintModal = document.querySelector('.paint-modal');
			if (existingPaintModal) {
				existingPaintModal.remove();
			}

			const paintModal = document.createElement("div");
			paintModal.className = "paint-modal";

			// Style the modal for bottom right corner
			paintModal.style.position = "fixed";
			paintModal.style.bottom = "20px";
			paintModal.style.right = "20px";
			paintModal.style.backgroundColor = "#2c3e50"; // Dark blue-grey background
			paintModal.style.color = "#ffffff"; // White text
			paintModal.style.padding = "12px 16px"; // Compact padding
			paintModal.style.border = "2px solid #3498db"; // Blue border
			paintModal.style.borderRadius = "8px"; // Rounded corners
			paintModal.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)"; // Shadow for depth
			paintModal.style.zIndex = "1001"; // Higher than other modals
			paintModal.style.fontSize = "14px"; // Smaller, readable text
			paintModal.style.fontWeight = "600"; // Semi-bold text
			paintModal.style.width = "200px"; // Limit width
			paintModal.style.minHeight = "20px"; // Add minimum height
			paintModal.style.maxHeight = "80px"; // Add maximum height
			paintModal.style.wordWrap = "break-word"; // Wrap long words
			paintModal.style.whiteSpace = "normal"; // Allow text wrapping
			paintModal.style.overflowWrap = "break-word"; // Break long words if needed
			paintModal.style.textAlign = "center";
			paintModal.style.display = "flex"; // Use flexbox for better text centering
			paintModal.style.alignItems = "center"; // Center text vertically
			paintModal.style.justifyContent = "center"; // Center text horizontally
			paintModal.style.opacity = "0"; // Start invisible for fade-in effect
			paintModal.style.transform = "translateY(10px)"; // Start slightly below
			paintModal.style.transition = "all 0.3s ease"; // Smooth animation

			paintModal.innerHTML = l10n.get(bodyPartName);
			document.body.appendChild(paintModal);

			// Trigger fade-in animation
			setTimeout(() => {
				paintModal.style.opacity = "1";
				paintModal.style.transform = "translateY(0)";
			}, 10);

			// Make the modal disappear after 2 seconds with fade-out
			setTimeout(() => {
				if (paintModal && paintModal.parentNode === document.body) {
					paintModal.style.opacity = "0";
					paintModal.style.transform = "translateY(10px)";
					
					// Remove after animation completes
					setTimeout(() => {
						if (paintModal && paintModal.parentNode === document.body) {
							document.body.removeChild(paintModal);
						}
					}, 300);
				}
			}, 2000);
		}

		// handle the click event for painting
		function handlePaintMode(object) {

			if (!object.userData.originalMaterial) {
				// Store original material if not already stored
				object.userData.originalMaterial = object.material.clone();
			}

			// Check current color
			const currentColor = object.material.color;
			const isDefaultColor = currentColor.equals(new THREE.Color("#ffffff")) || currentColor.equals(object.userData.originalMaterial.color);

			// Find the body part name for the modal
			let clickedBodyPart = bodyParts.find((part) => part.mesh === object.name);
			let bodyPartName = clickedBodyPart ? clickedBodyPart.name : object.name;
			showPaintModal(bodyPartName);

			// Update partsColored array
			const index = partsColored.findIndex(([name, color]) => name === object.name);
			if (index !== -1) {
				partsColored.splice(index, 1);
			}

			const newColor = isDefaultColor ? fillColor : "#ffffff";
			partsColored.push([object.name, newColor]);

			// Apply new material
			if (isDefaultColor) {
				// Apply fill color
				object.material = new THREE.MeshStandardMaterial({
					color: new THREE.Color(fillColor),
					side: THREE.DoubleSide,
					transparent: false,
					opacity: 1.0,
					depthTest: true,
					depthWrite: true
				});
			} else {
				// Restore original material
				object.material = object.userData.originalMaterial.clone();
				console.log("Restored original material");
			}

			// Sync with network if available
			if (presence) {
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: "init",
					content: [partsColored, players],
				});
			}
		}

		// handle the click event for doctor mode checks if the clicked object is the correct body part
		function handleDoctorMode(object) {
			if (presence) {
				const targetMeshName = bodyParts[presenceCorrectIndex].mesh;

				if (object.name === targetMeshName) {
					if (ifDoctorHost) {
						firstAnswer = true;
						let target = players.findIndex(
							(innerArray) => innerArray[0] === username
						);
						console.log("the doctor is in");
						players[target][1]++;
						presence.sendMessage(
							presence.getSharedInfo().id,
							{
								user: presence.getUserInfo(),
								action: "update",
								content: players,
							}
						);
						showLeaderboard();
					}

					if (!ifDoctorHost) {
						presence.sendMessage(
							presence.getSharedInfo().id,
							{
								user: presence.getUserInfo(),
								action: "answer",
							}
						);
					}

					showModal(l10n.get("CorrectButFastest"));
					presenceIndex++;
					setTimeout(startDoctorModePresence, 1500);
				} else {
					showModal(l10n.get("Wrong"));
				}
			} else {
				const targetMeshName = bodyParts[currentBodyPartIndex].mesh;

				if (object.name === targetMeshName) {
					showModal(
						l10n.get("Correct") + " " +
						(bodyParts[++currentBodyPartIndex] ?
							l10n.get("NextPart", { name: bodyParts[currentBodyPartIndex].name }) : "")
					);
				} else {
					showModal(
						bodyParts[++currentBodyPartIndex]?
							l10n.get("TryToFind", { name: bodyParts[currentBodyPartIndex].name }) :
							""
					);
				}

				if (currentBodyPartIndex >= bodyParts.length) {
					showModal(l10n.get("GameOver"));
					stopDoctorMode();
				}
			}
		}

		// click handler that uses screen-space testing
		function onMouseClick(event) {
			const rect = renderer.domElement.getBoundingClientRect();
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;

			// Convert to normalized device coordinates
			mouse.x = (x / rect.width) * 2 - 1;
			mouse.y = -(y / rect.height) * 2 + 1;

			// Create a new raycaster with looser parameters
			const altRaycaster = new THREE.Raycaster();
			altRaycaster.setFromCamera(mouse, camera);

			// Set more permissive parameters
			altRaycaster.near = 0.01;
			altRaycaster.far = 1000;
			altRaycaster.params.Points.threshold = 1.0;
			altRaycaster.params.Line.threshold = 1.0;

			// Test intersection with everything
			const intersects = altRaycaster.intersectObjects(scene.children, true);

			if (intersects.length > 0) {
				// Handle the first intersection found
				const intersect = intersects[0];
				handleIntersection(intersect);
			} else {
				// No intersection found, check for closest mesh
				findClosestMeshToRay(altRaycaster);
			}
		}

		function findClosestMeshToRay(raycaster) {
			let closestMesh = null;
			let closestDistance = Infinity;

			scene.traverse((child) => {
				if (child.isMesh && child.visible) {
					// Get mesh center
					if (!child.geometry.boundingBox) {
						child.geometry.computeBoundingBox();
					}

					const boundingBox = child.geometry.boundingBox.clone();
					boundingBox.applyMatrix4(child.matrixWorld);
					const center = boundingBox.getCenter(new THREE.Vector3());

					// Calculate distance from ray to mesh center
					const distance = raycaster.ray.distanceToPoint(center);

					// Within 2 units of the ray
					if (distance < closestDistance && distance < 2.0) { 
						closestDistance = distance;
						closestMesh = child;
					}
				}
			});

			if (closestMesh) {

				if (isPaintActive) {
					handlePaintMode(closestMesh);
				} else if (isDoctorActive) {
					handleDoctorMode(closestMesh);
				}
			} else {
				console.log("No mesh found close to ray");
			}
		}

		window.addEventListener("click", onMouseClick, false);

		function animate() {
			renderer.render(scene, camera);
		}

		renderer.setAnimationLoop(animate);
	});
});
