define([
	"sugar-web/activity/activity",
	"sugar-web/env",
	"sugar-web/datastore",
	"sugar-web/graphics/presencepalette",
	"sugar-web/graphics/journalchooser",
	"activity/palettes/speedpalette",
	// "activity/palettes/templatepalette",  // Temporarily commented out due to loading issues
	"tutorial",
	"l10n",
	"humane"
], function (
	activity,
	env,
	datastore,
	presencepalette,
	journalchooser,
	speedpalette,
	// templatepalette,  // Temporarily commented out
	tutorial,
	l10n,
	humane
) {
	const tf = window.tf;
	const posenet = window.posenet;

	// Debug: Check if TensorFlow.js and PoseNet are available
	console.log("=== Activity Module Loading Debug ===");
	console.log("TensorFlow.js available:", typeof tf !== 'undefined');
	console.log("PoseNet available:", typeof posenet !== 'undefined');
	if (typeof tf !== 'undefined') {
		console.log("TensorFlow.js version:", tf.version?.tfjs);
	}
	console.log("====================================");

	// Manipulate the DOM only when it is ready.
	requirejs(['domReady!'], function (doc) {

		// STATE VARIABLES
		let canvas, ctx;

		let baseFrames = {}; 	// Store first frame with absolute positions for each stickman
		let deltaFrames = {}; 	// Store relative movement deltas for subsequent frames
		let stickmen = []; 		// Array of stickmen (current working positions)

		let currentFrameIndices = {}; 
		let isPlaying = false;
		let speed = 1;
		let selectedJoint = null;
		let selectedStickmanIndex = -1;
		let isDragging = false;
		let isDraggingWhole = false;
		let templates = {};
		let currentSpeed = 1;
		let dragStartPos = { x: 0, y: 0 };
		let originalJoints = [];
		let nextStickmanId = 0;
		let isRemovalMode = false;
		let currentenv;
		let isShared = false;
		let isRotating = false;
		let rotationPivot = null;
		let rotationStartAngle = 0;
		let neckManuallyMoved = false; 

		// PoseNet configuration - using ResNet50 for better accuracy
		let posenetModel = null; 
		const posenetConfig = {
			architecture: 'ResNet50',
			outputStride: 32,      // ResNet50 supports 32 and 16, 32 is faster
			inputResolution: 513,  // Higher resolution for better accuracy
			quantBytes: 2          // Use 2 bytes for good balance of accuracy and performance
		}; 

		let lastMovementBroadcast = 0;
		const MOVEMENT_BROADCAST_THROTTLE = 50;

		// Add these variables for remote stickman management
		let remoteStickmanPositions = {}; // Store local positions for remote stickmen
		let isDraggingRemote = false;

		// PRESENCE VARIABLES
		let presence = null;
		let isHost = false;
		let stickmanUserColors = {}; // Maps stickman ID to user color data

		// UTILITY FUNCTIONS
		
		function deepClone(obj) {
			return JSON.parse(JSON.stringify(obj));
		} 

		// Check if a stickman is owned by the current user
		function isStickmanOwned(stickmanId) {
			if (!isShared || !presence || !currentenv || !currentenv.user) {
				return true; // Not in shared mode or no user info, assume owned
			}
			
			const currentUser = presence.getUserInfo();
			return currentUser && stickmanId.toString().startsWith(currentUser.networkId);
		} 

		// Joint hierarchy - defines parent-child relationships for rotation
		const jointHierarchy = {
			2: [11], 		// hip -> middle
			11: [1], 		// middle -> body (neck rotates around middle)
			1: [0, 7, 9], 	// body -> head, left elbow, right elbow
			7: [8], 		// left elbow -> left hand
			9: [10], 		// right elbow -> right hand
			3: [4], 		// left knee -> left foot
			5: [6]			// right knee -> right foot
		};

		// Joint connections with proper distances
		const jointConnections = [
			{ from: 1, to: 0, length: 20 },    // body to head 
			{ from: 11, to: 1, length: 30 },   // middle to body
			{ from: 2, to: 11, length: 30 },   // hips to middle
			{ from: 2, to: 3, length: 40 },    // hips to left knee
			{ from: 3, to: 4, length: 40 },    // left knee to foot
			{ from: 2, to: 5, length: 40 },    // hips to right knee
			{ from: 5, to: 6, length: 40 },    // right knee to foot
			{ from: 1, to: 7, length: 40 },    // body to left elbow
			{ from: 7, to: 8, length: 30 },    // left elbow to hand
			{ from: 1, to: 9, length: 40 },    // body to right elbow
			{ from: 9, to: 10, length: 30 }    // right elbow to hand
		];

		// DELTA FRAME SYSTEM FUNCTIONS

		function calculateDeltas(currentJoints, previousJoints) {
			if (!previousJoints || currentJoints.length !== previousJoints.length) {
				return null;
			}
			
			// Create a copy of current joints and enforce constraints
			const constrainedJoints = deepClone(currentJoints);
			enforceJointDistances(constrainedJoints);
			
			return constrainedJoints.map((joint, index) => ({
				dx: joint.x - previousJoints[index].x,
				dy: joint.y - previousJoints[index].y,
				name: joint.name
			}));
		}

		function applyDeltas(baseJoints, deltas) {
			if (!deltas || baseJoints.length !== deltas.length) {
				return deepClone(baseJoints);
			}
			
			const newJoints = baseJoints.map((joint, index) => ({
				x: joint.x + deltas[index].dx,
				y: joint.y + deltas[index].dy,
				name: joint.name
			}));
			
			// Apply distance constraints to maintain limb lengths
			enforceJointDistances(newJoints);
			
			return newJoints;
		}

		function enforceJointDistances(joints) {
			// Apply joint distance constraints with a hierarchical approach
			// Start from the root (hips) and work outward to maintain stability
			const processOrder = [
				{ from: 2, to: 11 },   // hips to middle
				{ from: 11, to: 1 },   // middle to body  
				{ from: 1, to: 0 },    // body to head
				{ from: 1, to: 7 },    // body to left elbow
				{ from: 7, to: 8 },    // left elbow to left hand
				{ from: 1, to: 9 },    // body to right elbow
				{ from: 9, to: 10 },   // right elbow to right hand
				{ from: 2, to: 3 },    // hips to left knee
				{ from: 3, to: 4 },    // left knee to left foot
				{ from: 2, to: 5 },    // hips to right knee
				{ from: 5, to: 6 }     // right knee to right foot
			];
			
			// Apply constraints in hierarchical order
			for (let iteration = 0; iteration < 2; iteration++) {
				processOrder.forEach(conn => {
					const joint1 = joints[conn.from];
					const joint2 = joints[conn.to];
					
					if (!joint1 || !joint2) return;
					
					const dx = joint2.x - joint1.x;
					const dy = joint2.y - joint1.y;
					const currentDistance = Math.sqrt(dx * dx + dy * dy);
					const targetDistance = jointConnections.find(jc => jc.from === conn.from && jc.to === conn.to)?.length;
					
					if (targetDistance && currentDistance > 0 && Math.abs(currentDistance - targetDistance) > 0.5) {
						const ratio = targetDistance / currentDistance;
						const newX = joint1.x + dx * ratio;
						const newY = joint1.y + dy * ratio;
						
						// Move the child joint to maintain distance from parent
						joint2.x = newX;
						joint2.y = newY;
					}
				});
			}
		}

		function reconstructFrameFromDeltas(stickmanId, frameIndex) {
			if (!baseFrames[stickmanId] || frameIndex < 0) {
				return null;
			}
			
			if (frameIndex === 0) {
				// First frame is always the base frame
				return JSON.parse(JSON.stringify({
					id: stickmanId,
					joints: baseFrames[stickmanId]
				}));
			}
			
			if (!deltaFrames[stickmanId] || frameIndex - 1 >= deltaFrames[stickmanId].length) {
				return null;
			}
			
			// Start with base frame and apply deltas incrementally
			let currentJoints = deepClone(baseFrames[stickmanId]);
			
			for (let i = 0; i < frameIndex; i++) {
				if (deltaFrames[stickmanId][i]) {
					currentJoints = applyDeltas(currentJoints, deltaFrames[stickmanId][i]);
					// Enforce joint distance constraints after each delta application
					enforceJointDistances(currentJoints);
				}
			}
			
			return {
				id: stickmanId,
				joints: currentJoints
			};
		}

		function rebaseDeltas(stickmanId, removedFrameIndex) {
			if (!deltaFrames[stickmanId] || removedFrameIndex <= 0) return;
			
			const getTotalFrameCount = (id) => {
				if (!baseFrames[id]) return 0;
				return 1 + (deltaFrames[id] ? deltaFrames[id].length : 0);
			};
			
			if (removedFrameIndex === 1) {
				// Removing second frame - need to update base frame and recompute all deltas
				const newBaseFrame = reconstructFrameFromDeltas(stickmanId, 1);
				if (newBaseFrame) {
					baseFrames[stickmanId] = newBaseFrame.joints;
					
					// Recompute all deltas relative to new base
					const newDeltas = [];
					for (let i = 2; i < getTotalFrameCount(stickmanId); i++) {
						const frame = reconstructFrameFromDeltas(stickmanId, i);
						if (frame) {
							const delta = calculateDeltas(frame.joints, baseFrames[stickmanId]);
							if (delta) newDeltas.push(delta);
						}
					}
					deltaFrames[stickmanId] = newDeltas;
				}
			} else {
				// Remove delta frame and recompute subsequent deltas
				const originalDeltas = [...deltaFrames[stickmanId]];
				deltaFrames[stickmanId].splice(removedFrameIndex - 1, 1);
				
				// Recompute deltas for frames after the removed one
				for (let i = removedFrameIndex - 1; i < deltaFrames[stickmanId].length; i++) {
					const currentFrame = reconstructFrameFromDeltas(stickmanId, i + 1);
					const previousFrame = reconstructFrameFromDeltas(stickmanId, i);
					
					if (currentFrame && previousFrame) {
						const newDelta = calculateDeltas(currentFrame.joints, previousFrame.joints);
						if (newDelta) {
							deltaFrames[stickmanId][i] = newDelta;
						}
					}
				}
			}
		}

		// INITIALIZATION FUNCTIONS

		function initializeAnimator() {
			const canvasElement = document.getElementById('stickman-canvas');
			if (canvasElement) {
				initCanvas();
				initEvents();
				initControls();
				render();
			} else {
				console.warn('Canvas element not found, retrying...');
				setTimeout(initializeAnimator, 100);
			}
		}

		function setupDatastore() {
			activity.setup();

			env.getEnvironment(function (err, environment) {
				currentenv = environment;

				// Set current language to Sugarizer
				var defaultLanguage = (typeof chrome != 'undefined' && chrome.app && chrome.app.runtime) ? chrome.i18n.getUILanguage() : navigator.language;
				var language = environment.user ? environment.user.language : defaultLanguage;
				l10n.init(language);

				if (environment.sharedId) {
					console.log("Shared instance");
					isShared = true;
					presence = activity.getPresenceObject(function (error, network) {
						if (error) {
							console.log("Error joining shared activity:", error);
							return;
						}
						console.log("Joined shared activity");

						// Set up handlers immediately - like HumanBody
						network.onDataReceived(onNetworkDataReceived);
						network.onSharedActivityUserChanged(onNetworkUserChanged);

						// Improved host status detection
						try {
							const sharedInfo = network.getSharedInfo();
							const userInfo = network.getUserInfo();

							console.log("Shared info:", sharedInfo);
							console.log("User info:", userInfo);

							// More robust host detection
							if (sharedInfo && userInfo && sharedInfo.owner && userInfo.networkId) {
								isHost = userInfo.networkId === sharedInfo.owner;
							} else {
								// If we can't determine host status, assume not host
								isHost = false;
							}

							console.log("Host status:", isHost);

						} catch (e) {
							console.log("Error checking host status:", e);
							isHost = false;
							console.log("Fallback host status:", isHost);
						}
					});
				}

				// Load from datastore
				if (!environment.objectId) {
					console.log("New instance");

					// Only create initial stickman if NOT in shared mode or if we're the host
					if (!environment.sharedId) {
						createInitialStickman();
						updateTimeline();
						updateRemoveButtonState();
						render();
					} else {
						// In shared mode, non-host users start with empty canvas
						// and wait for data from host
						console.log("Shared mode - waiting for host data");
						stickmen = [];
						updateTimeline();
						updateRemoveButtonState();
						render();
					}
				} else {
					// load saved data
					activity.getDatastoreObject().loadAsText(function (error, metadata, data) {
						if (error == null && data != null) {
							const savedData = JSON.parse(data);

							baseFrames = savedData.baseFrames || {};
							deltaFrames = savedData.deltaFrames || {};
							currentFrameIndices = savedData.currentFrameIndices || {};
							speed = savedData.speed || 1;
							currentSpeed = savedData.currentSpeed || 1;
							nextStickmanId = savedData.nextStickmanId || 0;
							stickmanUserColors = savedData.stickmanUserColors || {};

							// Reconstruct stickmen 
							if (Object.keys(baseFrames).length > 0) {
								stickmen = [];
								
								Object.keys(baseFrames).forEach(stickmanIdStr => {
									const stickmanId = stickmanIdStr; // Keep as string for networkId format
									const frameIndex = currentFrameIndices[stickmanId] || 0;
									const stickman = reconstructFrameFromDeltas(stickmanId, frameIndex);
									if (stickman) {
										stickmen.push(stickman);
									}
								});
								
								stickmen.forEach((_, index) => updateMiddleJoint(index));
								
								// Select first stickman by default
								if (stickmen.length > 0) {
									selectedStickmanIndex = 0;
								}
							} else {
								createInitialStickman();
							}

							updateTimeline();
							updateRemoveButtonState(); 
							render();
						} else {
							console.log("No instance found, creating new instance");
							createInitialStickman();
							updateTimeline();
							updateRemoveButtonState();
							render();
						}
					});
				}
			});
		}

		// translate toolbar buttons (localize the toolbar buttons)
		function translateToolbarButtons() {
			const buttonsToTranslate = [
				{ id: 'network-button', key: 'Network' },
				{ id: 'play-pause-button', key: 'PlayPause' },
				{ id: 'speed-button', key: 'Speed' },
				{ id: 'minus-button', key: 'RemoveStickman' },
				{ id: 'addStickman-button', key: 'AddStickman' },
				{ id: 'template-button', key: 'Templates' },
				{ id: 'importJournal-button', key: 'ImportFromJournal' },
				{ id: 'import-button', key: 'Import' },
				{ id: 'export-button', key: 'Export' },
				{ id: 'stop-button', key: 'Stop' },
				{ id: 'fullscreen-button', key: 'Fullscreen' },
				{ id: 'help-button', key: 'Tutorial' },
				{ id: 'add-button', key: 'AddFrame' }
			];

			buttonsToTranslate.forEach(button => {
				const element = document.getElementById(button.id);
				if (element) {
					const translatedText = l10n.get(button.key);
					if (translatedText) {
						element.title = translatedText;
					}
				}
			});
		}

		document.getElementById('stop-button').addEventListener('click', function () {
			console.log("writing...");

			if (currentenv && currentenv.user) {
				const currentUserId = currentenv.user.networkId || currentenv.user.name || 'user';

				// updated with current user ownership
				const updatedBaseFrames = {};
				const updatedDeltaFrames = {};
				const updatedCurrentFrameIndices = {};
				const updatedStickmanUserColors = {};

				// update ownership
				stickmen.forEach((stickman, index) => {
					const oldId = stickman.id;
					let newId;

					if (typeof oldId === 'string' && oldId.includes('_')) {
						const timestamp = oldId.split('_').slice(1).join('_') || Date.now();
						newId = `${currentUserId}_${timestamp}`;
					} else {
						newId = `${currentUserId}_${Date.now()}_${index}`;
					}

					stickman.id = newId;

					if (baseFrames[oldId]) {
						updatedBaseFrames[newId] = baseFrames[oldId];
					}
					if (deltaFrames[oldId]) {
						updatedDeltaFrames[newId] = deltaFrames[oldId];
					}
					if (currentFrameIndices[oldId] !== undefined) {
						updatedCurrentFrameIndices[newId] = currentFrameIndices[oldId];
					}
					// Assign current user's color to all stickmen
					if (currentenv.user.colorvalue) {
						updatedStickmanUserColors[newId] = currentenv.user.colorvalue;
					}
				});

				// Replace the original data structures
				baseFrames = updatedBaseFrames;
				deltaFrames = updatedDeltaFrames;
				currentFrameIndices = updatedCurrentFrameIndices;
				stickmanUserColors = updatedStickmanUserColors;

				console.log("All stickmen ownership updated to current user before saving");
			}

			const saveData = {
				baseFrames: baseFrames,
				deltaFrames: deltaFrames,
				currentFrameIndices: currentFrameIndices,
				speed: speed,
				currentSpeed: currentSpeed,
				nextStickmanId: nextStickmanId,
				stickmanUserColors: stickmanUserColors
			};

			var jsonData = JSON.stringify(saveData);
			activity.getDatastoreObject().setDataAsText(jsonData);
			activity.getDatastoreObject().save(function (error) {
				if (error === null) {
					console.log("write done.");
				} else {
					console.log("write failed.");
				}
				activity.close();
			});
		});

		document.getElementById("help-button").addEventListener('click', function (e) {
			tutorial.start();
		});

		function initCanvas() {
			canvas = document.getElementById('stickman-canvas');
			ctx = canvas.getContext('2d');
			resizeCanvas();
			window.addEventListener('resize', resizeCanvas);
		}

		function resizeCanvas() {
			canvas.width = canvas.parentElement.clientWidth - 32;
			// Reduce canvas height by an additional 50 pixels to ensure stickmen never go behind the timeline
			canvas.height = canvas.parentElement.clientHeight - 250;
		}

		function initEvents() {
			canvas.addEventListener('mousedown', handleMouseDown);
			canvas.addEventListener('mousemove', handleMouseMove);
			canvas.addEventListener('mouseup', handleMouseUp);

			// Control buttons
			document.getElementById('add-button').addEventListener('click', addFrame);
			document.getElementById('export-button').addEventListener('click', exportAnimation);
			document.getElementById('addStickman-button').addEventListener('click', addNewStickman);
			document.getElementById('minus-button').addEventListener('click', removeSelectedStickman);
			document.getElementById('importJournal-button').addEventListener('click', importFromJournal);
			document.getElementById('import-button').addEventListener('click', importVideoAnimation);

			// Initialize datastore
			setupDatastore();
		}

		function initControls() {
			// Play/Pause button setup
			const playPauseButton = document.getElementById('play-pause-button');
			playPauseButton.style.backgroundImage = "url('icons/play.svg')";
			playPauseButton.style.backgroundPosition = "center";
			playPauseButton.style.backgroundRepeat = "no-repeat";
			playPauseButton.style.backgroundSize = "contain";
			playPauseButton.addEventListener('click', togglePlayPause);

			// Speed control setup
			const speedButton = document.getElementById("speed-button");
			const speedPalette = new speedpalette.SpeedPalette(speedButton);
			speedPalette.addEventListener('speed', function (e) {
				currentSpeed = e.detail.speed;
				speed = currentSpeed;
				console.log("Speed set to:", currentSpeed.toFixed(2) + "x");
			});

			// Template palette - temporarily disabled due to loading issues
			var templateButton = document.getElementById("template-button");
			// var templatePalette = new templatepalette.TemplatePalette(templateButton);

			document.addEventListener('template-selected', function (e) {
				loadTemplate(e.detail.template);
			});

			// Presence palette setup
			var palette = new presencepalette.PresencePalette(
				document.getElementById("network-button"),
				undefined
			);

			palette.addEventListener('shared', function () {
				palette.popDown();
				presence = activity.getPresenceObject(function (error, network) {
					if (error) {
						console.log("Sharing error:", error);
						return;
					}

					network.createSharedActivity('org.sugarlabs.Stickman', function (groupId) {
						console.log("Activity shared");
						isShared = true;
						isHost = true;

						// Initialize network handlers
						network.onDataReceived(onNetworkDataReceived);
						network.onSharedActivityUserChanged(onNetworkUserChanged);

						// Create initial stickman for host if none exists
						if (stickmen.length === 0) {
							createInitialStickman();
							updateTimeline();
							updateRemoveButtonState();
						}

						// Update existing stickman IDs to use network format
						if (stickmen.length > 0) {
							stickmen.forEach(stickman => {
								if (typeof stickman.id === 'number') {
									const oldId = stickman.id;
									const newId = `${currentenv.user.networkId}_${Date.now()}`;

									// Update stickman ID
									stickman.id = newId;

									// Update all related data structures
									if (baseFrames[oldId]) {
										baseFrames[newId] = baseFrames[oldId];
										delete baseFrames[oldId];
									}
									if (deltaFrames[oldId]) {
										deltaFrames[newId] = deltaFrames[oldId];
										delete deltaFrames[oldId];
									}
									if (currentFrameIndices[oldId] !== undefined) {
										currentFrameIndices[newId] = currentFrameIndices[oldId];
										delete currentFrameIndices[oldId];
									}
									if (stickmanUserColors[oldId]) {
										stickmanUserColors[newId] = stickmanUserColors[oldId];
										delete stickmanUserColors[oldId];
									}
								}
							});
							updateTimeline();
						}

						// Send initial data to any waiting users
						setTimeout(sendAllStickmen, 500);
					});
				});
			});
		}

		// function to reset remote positions when receiving updates
		function resetRemoteStickmanPosition(stickmanId) {
			if (remoteStickmanPositions[stickmanId]) {
				// Store the current local offset before resetting
				const offsetX = remoteStickmanPositions[stickmanId].offsetX || 0;
				const offsetY = remoteStickmanPositions[stickmanId].offsetY || 0;
				
				// Update the original joints to the new network data (without the offset)
				const stickmanIndex = stickmen.findIndex(s => s.id === stickmanId);
				if (stickmanIndex !== -1) {
					// The current joints already have the network update, so we store them as the new original
					const currentJointsWithoutOffset = stickmen[stickmanIndex].joints.map(joint => ({
						x: joint.x - offsetX,
						y: joint.y - offsetY,
						name: joint.name
					}));
					
					// Update the original joints to the new network position
					remoteStickmanPositions[stickmanId].originalJoints = deepClone(currentJointsWithoutOffset);
					
					// Reapply the local offset to maintain the user's positioning
					stickmen[stickmanIndex].joints.forEach((joint, index) => {
						joint.x = currentJointsWithoutOffset[index].x + offsetX;
						joint.y = currentJointsWithoutOffset[index].y + offsetY;
					});
				}
			}
		}

		// NETWORK CALLBACKS

		var onNetworkDataReceived = function (msg) {
			console.log("Raw message received:", msg);

			if (presence.getUserInfo().networkId === msg.user.networkId) {
				console.log("Ignoring own message");
				return;
			}

			console.log("Processing message from:", msg.user.networkId);

			if (msg.action === 'new_stickman') {
				console.log("Received new stickman with ID", msg.content.stickman.id);
				processIncomingStickman(msg.content.stickman, msg.content.stickman.id, msg.content.color);
				render();
			}

			if (msg.action === 'all_stickmen') {
				console.log("Receiving all stickmen, count:", msg.content.length);
				msg.content.forEach(stickman => {
					console.log("Processing stickman from all_stickmen:", stickman.id);
					processIncomingStickman(stickman, stickman.id, stickman.color);
				});
				render();
			}

			if (msg.action === 'stickman_update' || msg.action === 'stickman_final_position') {
				console.log("Receiving stickman update for", msg.content.stickmanId);
				const stickmanId = msg.content.stickmanId;
				updateStickmanFromNetwork(msg.content);
				render();
			}

			if (msg.action === 'stickman_movement') {
				console.log("Receiving real-time movement for", msg.content.stickmanId);
				processStickmanMovement(msg.content);
				render();
			}

			if (msg.action === 'remote_stickman_movement') {
				console.log("Receiving remote stickman movement for", msg.content.stickmanId);
				processRemoteStickmanMovement(msg.content);
				render();
			}

			if (msg.action === 'stickman_removal') {
				console.log("Receiving stickman removal for", msg.content.stickmanId);
				processStickmanRemoval(msg.content);
				render();
			}
		};

		var onNetworkUserChanged = function (msg) {
			if (!msg || !msg.user) return;

			console.log("User " + msg.user.name + " " + (msg.move == 1 ? "joined" : "left"));

			if (isHost && msg.move == 1) {
				// Host sends all stickmen to new user
				console.log("Host sending all stickmen to new user");
				setTimeout(sendAllStickmen, 500); // Small delay to ensure connection is ready
			}
		};

		function sendAllStickmen() {
			if (!isHost || !presence) {
				console.log("Not host or presence not available");
				return;
			}

			try {
				const stickmenData = stickmen.map(stickman => {
					const id = stickman.id;
					return {
						id: id,
						joints: stickman.joints,
						baseFrame: baseFrames[id],
						deltaFrames: deltaFrames[id],
						color: stickmanUserColors[id],
						currentFrameIndex: currentFrameIndices[id] || 0
					};
				});

				console.log("Sending all stickmen data:", stickmenData);

				// Send even if empty array to sync removal state
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: "all_stickmen",
					content: stickmenData
				});
			} catch (error) {
				console.log("Error sending stickmen data:", error);
				setTimeout(sendAllStickmen, 1000);
			}
		}

		function broadcastStickman(stickmanData) {
			if (!isHost || !presence) {
				console.log("Not host or presence not available");
				return;
			}

			try {
				console.log("Broadcasting new stickman:", stickmanData);
				presence.sendMessage({
					type: 'new_stickman',
					stickman: stickmanData.stickman,
					color: stickmanData.color
				});
			} catch (error) {
				console.log("Error broadcasting stickman:", error);
				setTimeout(() => broadcastStickman(stickmanData), 1000);
			}
		}

		// Allows users to drag remote stickmen (created by other users) across the screen
		function broadcastRemoteStickmanMovement(stickmanIndex, movementType, data = {}) {
			if (!isShared || !presence || stickmanIndex < 0 || stickmanIndex >= stickmen.length) {
				return;
			}

			// Throttle movement broadcasts to prevent spam
			const now = Date.now();
			if (now - lastMovementBroadcast < MOVEMENT_BROADCAST_THROTTLE) {
				return;
			}
			lastMovementBroadcast = now;

			try {
				const stickman = stickmen[stickmanIndex];
				const stickmanId = stickman.id;

				const message = {
					user: presence.getUserInfo(),
					action: 'remote_stickman_movement',
					content: {
						stickmanId: stickmanId,
						movementType: movementType,
						joints: deepClone(stickman.joints),
						timestamp: now,
						...data
					}
				};

				console.log("Broadcasting remote movement:", movementType, "for stickman:", stickmanId);
				presence.sendMessage(presence.getSharedInfo().id, message);
			} catch (error) {
				console.log("Error broadcasting remote movement:", error);
			}
		}

		function processRemoteStickmanMovement(movementData) {
			const { 
				stickmanId, 
				movementType, 
				joints
			} = movementData;

			console.log("Processing remote movement:", movementType, "for stickman:", stickmanId);

			// Find the stickman to update
			const stickmanIndex = stickmen.findIndex(s => s.id === stickmanId);
			if (stickmanIndex === -1) {
				console.log("Stickman not found for remote movement update:", stickmanId);
				return;
			}

			// Don't process movements of currently selected stickman to avoid conflicts
			if (stickmanIndex === selectedStickmanIndex && (isDragging || isDraggingWhole || isRotating)) {
				console.log("Ignoring remote movement - stickman is currently being manipulated");
				return;
			}

			// Update the stickman joints with received data
			if (joints && joints.length === stickmen[stickmanIndex].joints.length) {
				stickmen[stickmanIndex].joints = deepClone(joints);
				updateMiddleJoint(stickmanIndex);
				console.log("Updated remote stickman movement for:", stickmanId);
			}
		}

		function broadcastStickmanMovement(stickmanIndex, movementType, data = {}) {
			if (!isShared || !presence || stickmanIndex < 0 || stickmanIndex >= stickmen.length) {
				return;
			}

			// Throttle movement broadcasts to prevent spam
			const now = Date.now();
			if (now - lastMovementBroadcast < MOVEMENT_BROADCAST_THROTTLE) {
				return;
			}
			lastMovementBroadcast = now;

			try {
				const stickman = stickmen[stickmanIndex];
				const stickmanId = stickman.id;

				// Only broadcast movements of own stickmen
				if (!isStickmanOwned(stickmanId)) {
					return;
				}

				const message = {
					user: currentUser,
					action: 'stickman_movement',
					content: {
						stickmanId: stickmanId,
						movementType: movementType,
						joints: deepClone(stickman.joints),
						timestamp: now,
						...data
					}
				};

				console.log("Broadcasting movement:", movementType, "for stickman:", stickmanId);
				presence.sendMessage(presence.getSharedInfo().id, message);
			} catch (error) {
				console.log("Error broadcasting movement:", error);
			}
		}

		function processIncomingStickman(stickmanData, newId, color) {
			console.log("Processing incoming stickman - ID:", newId, "Current stickmen IDs:", stickmen.map(s => s.id));

			// Check if stickman already exists
			const existingIndex = stickmen.findIndex(s => s.id === newId);
			if (existingIndex !== -1) {
				console.log("Stickman already exists, updating:", newId);

				// Apply remote offset if it exists for this stickman
				let jointsToUse = deepClone(stickmanData.joints);
				if (remoteStickmanPositions[newId]) {
					const offsetX = remoteStickmanPositions[newId].offsetX || 0;
					const offsetY = remoteStickmanPositions[newId].offsetY || 0;
					
					// Update original joints to the new network data
					remoteStickmanPositions[newId].originalJoints = deepClone(stickmanData.joints);
					
					// Apply offset for display
					jointsToUse = jointsToUse.map(joint => ({
						x: joint.x + offsetX,
						y: joint.y + offsetY,
						name: joint.name
					}));
				}

				// Update existing stickman instead of ignoring
				stickmen[existingIndex].joints = jointsToUse;
				baseFrames[newId] = deepClone(stickmanData.baseFrame || stickmanData.joints);
				deltaFrames[newId] = deepClone(stickmanData.deltaFrames || []);
				currentFrameIndices[newId] = stickmanData.currentFrameIndex || 0;
				stickmanUserColors[newId] = color;

				updateMiddleJoint(existingIndex);
				updateTimeline();
				updateRemoveButtonState();
				return;
			}

			console.log("Adding new stickman with data:", stickmanData);
			
			// Apply remote offset if it exists for this stickman
			let jointsToUse = deepClone(stickmanData.joints);
			if (remoteStickmanPositions[newId]) {
				const offsetX = remoteStickmanPositions[newId].offsetX || 0;
				const offsetY = remoteStickmanPositions[newId].offsetY || 0;
				
				// Update original joints to the new network data
				remoteStickmanPositions[newId].originalJoints = deepClone(stickmanData.joints);
				
				// Apply offset for display
				jointsToUse = jointsToUse.map(joint => ({
					x: joint.x + offsetX,
					y: joint.y + offsetY,
					name: joint.name
				}));
			}
			
			const newStickman = {
				id: newId,
				joints: jointsToUse
			};

			stickmen.push(newStickman);
			baseFrames[newId] = deepClone(stickmanData.baseFrame || stickmanData.joints);
			deltaFrames[newId] = deepClone(stickmanData.deltaFrames || []);
			currentFrameIndices[newId] = stickmanData.currentFrameIndex || 0;
			stickmanUserColors[newId] = color;

			console.log("Stickman added successfully. Total stickmen:", stickmen.length);
			console.log("New stickmen array:", stickmen.map(s => ({ id: s.id, joints: s.joints.length })));

			updateMiddleJoint(stickmen.length - 1);
			updateTimeline();
			updateRemoveButtonState();

			return {
				stickman: newStickman,
				color: color
			};
		}

		function processStickmanMovement(movementData) {
			const { stickmanId, movementType, joints, timestamp } = movementData;

			console.log("Processing movement:", movementType, "for stickman:", stickmanId);

			// Find the stickman to update
			const stickmanIndex = stickmen.findIndex(s => s.id === stickmanId);
			if (stickmanIndex === -1) {
				console.log("Stickman not found for movement update:", stickmanId);
				return;
			}

			// Don't process movements of currently selected stickman to avoid conflicts
			if (stickmanIndex === selectedStickmanIndex && (isDragging || isDraggingWhole || isRotating)) {
				console.log("Ignoring movement - stickman is currently being manipulated");
				return;
			}

			// Update the stickman joints with received data
			if (joints && joints.length === stickmen[stickmanIndex].joints.length) {
				stickmen[stickmanIndex].joints = deepClone(joints);

				// Update middle joint
				updateMiddleJoint(stickmanIndex);

				// Update current frame data to match the movement
				if (baseFrames[stickmanId] && currentFrameIndices[stickmanId] !== undefined) {
					const currentFrameIndex = currentFrameIndices[stickmanId];

					if (currentFrameIndex === 0) {
						// Update base frame
						baseFrames[stickmanId] = deepClone(joints);
					} else {
						// Update delta frame
						const previousFrame = reconstructFrameFromDeltas(stickmanId, currentFrameIndex - 1);
						if (previousFrame) {
							const newDelta = calculateDeltas(joints, previousFrame.joints);
							if (newDelta && deltaFrames[stickmanId]) {
								const deltaIndex = currentFrameIndex - 1;
								if (deltaIndex >= 0 && deltaIndex < deltaFrames[stickmanId].length) {
									deltaFrames[stickmanId][deltaIndex] = newDelta;
								}
							}
						}
					}
				}

				console.log("Updated stickman movement for:", stickmanId);
			}
		}

		function broadcastStickmanFinalPosition(stickmanIndex) {
			if (!isShared || !presence || stickmanIndex < 0 || stickmanIndex >= stickmen.length) {
				return;
			}

			try {
				const stickman = stickmen[stickmanIndex];
				const stickmanId = stickman.id;

				// Only broadcast final positions of own stickmen
				if (!isStickmanOwned(stickmanId)) {
					return;
				}

				const currentUser = presence.getUserInfo();

				const message = {
					user: currentUser,
					action: 'stickman_final_position',
					content: {
						stickmanId: stickmanId,
						joints: deepClone(stickman.joints),
						baseFrame: baseFrames[stickmanId],
						deltaFrames: deltaFrames[stickmanId],
						currentFrameIndex: currentFrameIndices[stickmanId],
						timestamp: Date.now()
					}
				};

				console.log("Broadcasting final position for stickman:", stickmanId);
				presence.sendMessage(presence.getSharedInfo().id, message);
			} catch (error) {
				console.log("Error broadcasting final position:", error);
			}
		}

		function updateStickmanFromNetwork(data) {
			const stickmanId = data.stickmanId;
			console.log("Updating stickman from network:", stickmanId);

			const stickmanIndex = stickmen.findIndex(s => s.id === stickmanId);
			if (stickmanIndex >= 0) {
				baseFrames[stickmanId] = deepClone(data.baseFrame);
				deltaFrames[stickmanId] = deepClone(data.deltaFrames);
				currentFrameIndices[stickmanId] = data.currentFrameIndex;

				// Reconstruct current frame
				const frame = reconstructFrameFromDeltas(stickmanId, data.currentFrameIndex);
				if (frame) {
					// Apply remote offset if it exists for this stickman
					if (remoteStickmanPositions[stickmanId]) {
						const offsetX = remoteStickmanPositions[stickmanId].offsetX || 0;
						const offsetY = remoteStickmanPositions[stickmanId].offsetY || 0;
						
						// Update original joints to the new network data
						remoteStickmanPositions[stickmanId].originalJoints = deepClone(frame.joints);
						
						// Apply offset for display
						frame.joints = frame.joints.map(joint => ({
							x: joint.x + offsetX,
							y: joint.y + offsetY,
							name: joint.name
						}));
					}
					
					stickmen[stickmanIndex] = frame;
					updateMiddleJoint(stickmanIndex);
					updateTimeline();
				}
			} else {
				console.log("Stickman not found for update:", stickmanId);
			}
		}

		function broadcastStickmanRemoval(stickmanId) {
			if (!isShared || !presence) {
				console.log("Not in shared mode or presence not available");
				return;
			}

			try {
				// Only broadcast removal of own stickmen
				if (!isStickmanOwned(stickmanId)) {
					return;
				}

				const currentUser = presence.getUserInfo();

				const message = {
					user: currentUser,
					action: 'stickman_removal',
					content: {
						stickmanId: stickmanId,
						timestamp: Date.now()
					}
				};

				console.log("Broadcasting stickman removal:", stickmanId);
				presence.sendMessage(presence.getSharedInfo().id, message);
			} catch (error) {
				console.log("Error broadcasting stickman removal:", error);
			}
		}

		function processStickmanRemoval(removalData) {
			const { stickmanId, timestamp } = removalData;
			console.log("Processing stickman removal:", stickmanId);

			// Clean up local position data
			if (remoteStickmanPositions[stickmanId]) {
				delete remoteStickmanPositions[stickmanId];
			}

			// Find and remove the stickman
			const stickmanIndex = stickmen.findIndex(s => s.id === stickmanId);
			if (stickmanIndex === -1) {
				console.log("Stickman not found for removal:", stickmanId);
				return;
			}

			console.log("Removing stickman:", stickmanId, "at index:", stickmanIndex);

			// Remove from current stickmen array
			stickmen.splice(stickmanIndex, 1);

			// Remove stickman data
			delete baseFrames[stickmanId];
			delete deltaFrames[stickmanId];
			delete currentFrameIndices[stickmanId];
			delete stickmanUserColors[stickmanId];

			// Adjust selected stickman index if needed
			if (selectedStickmanIndex === stickmanIndex) {
				selectedJoint = null;
				selectedStickmanIndex = stickmen.length > 0 ? 0 : -1;
			} else if (selectedStickmanIndex > stickmanIndex) {
				selectedStickmanIndex--;
			}

			console.log("Stickman removed. Total remaining:", stickmen.length);

			updateTimeline();
			updateRemoveButtonState();

			// If no stickmen remain for current user, create a new one
			if (stickmen.length === 0) {
				console.log("No stickmen remaining, creating new one");
				createInitialStickman();
				updateTimeline();
				updateRemoveButtonState();
			}
		}

		function updateRemoveButtonState() {
			const minusButton = document.getElementById('minus-button');

			// Count only owned stickmen in shared mode
			let ownedStickmenCount = stickmen.length;

			if (isShared && presence) {
				const currentUser = presence.getUserInfo();
				if (currentUser) {
					ownedStickmenCount = stickmen.filter(stickman =>
						isStickmanOwned(stickman.id)
					).length;
				}
			}

			if (ownedStickmenCount <= 1) {
				minusButton.disabled = true;
				minusButton.title = l10n.get("CannotRemoveLastStickman");
			} else {
				minusButton.disabled = false;
				minusButton.title = l10n.get("RemoveStickmanTooltip");
			}
		}

		// STICKMAN CREATION & MANAGEMENT

		function createStickmanJoints(centerX, centerY, id) {
			const scale = 1.0; // Can be adjusted for different sizes
			
			return {
				id: id,
				joints: [
					{ x: centerX, y: centerY - 65 * scale, name: 'head' },                    // 0 - head
					{ x: centerX, y: centerY - 45 * scale, name: 'body' },                    // 1 - body (neck)
					{ x: centerX, y: centerY + 15 * scale, name: 'hips' },                    // 2 - hips
					{ x: centerX - 15 * scale, y: centerY + 55 * scale, name: 'leftKnee' },   // 3 - left knee
					{ x: centerX - 20 * scale, y: centerY + 95 * scale, name: 'leftFoot' },   // 4 - left foot
					{ x: centerX + 15 * scale, y: centerY + 55 * scale, name: 'rightKnee' },  // 5 - right knee
					{ x: centerX + 20 * scale, y: centerY + 95 * scale, name: 'rightFoot' },  // 6 - right foot
					{ x: centerX - 25 * scale, y: centerY - 35 * scale, name: 'leftElbow' },  // 7 - left elbow
					{ x: centerX - 40 * scale, y: centerY - 5 * scale, name: 'leftHand' },    // 8 - left hand
					{ x: centerX + 25 * scale, y: centerY - 35 * scale, name: 'rightElbow' }, // 9 - right elbow
					{ x: centerX + 40 * scale, y: centerY - 5 * scale, name: 'rightHand' },   // 10 - right hand
					{ x: centerX, y: centerY - 15 * scale, name: 'middle' }                   // 11 - middle (torso center)
				]
			};
		}

		function createInitialStickman() {
			const centerX = canvas.width / 2;
			const centerY = canvas.height / 2 - 20;

			// Always use unique ID format in shared mode
			let stickmanId;
			if (isShared && currentenv && currentenv.user) {
				stickmanId = `${currentenv.user.networkId}_${Date.now()}`;
			} else {
				stickmanId = nextStickmanId++;
			}

			const initialStickman = createStickmanJoints(centerX, centerY, stickmanId);

			// Ensure the initial stickman has proper joint distances
			enforceJointDistances(initialStickman.joints);

			stickmen = [initialStickman];

			// Initialize base frame for this stickman
			baseFrames[initialStickman.id] = deepClone(initialStickman.joints);
			deltaFrames[initialStickman.id] = [];
			currentFrameIndices[initialStickman.id] = 0;

			// Associate this stickman with current user's color
			if (currentenv && currentenv.user && currentenv.user.colorvalue) {
				stickmanUserColors[initialStickman.id] = currentenv.user.colorvalue;
			}

			neckManuallyMoved = false;
			updateMiddleJoint(0);
			selectedStickmanIndex = 0;
			updateRemoveButtonState();
		}

		function addNewStickman() {
			// Calculate safe boundaries based on the improved stickman proportions
			const stickmanHeight = 160;
			const stickmanWidth = 80;
			const margin = 30;

			const minX = stickmanWidth / 2 + margin;
			const maxX = canvas.width - stickmanWidth / 2 - margin;
			const minY = 65 + margin;
			const maxY = canvas.height - 95 - margin;

			if (maxX <= minX || maxY <= minY) {
				console.warn("Canvas too small for new stickman");
				return;
			}

			let centerX, centerY;
			let attempts = 0;
			const maxAttempts = 20;
			const minDistance = 100;

			do {
				centerX = Math.random() * (maxX - minX) + minX;
				centerY = Math.random() * (maxY - minY) + minY;

				const isTooClose = stickmen.some(stickman => {
					const existingCenter = stickman.joints[11];
					const distance = Math.sqrt(
						Math.pow(centerX - existingCenter.x, 2) +
						Math.pow(centerY - existingCenter.y, 2)
					);
					return distance < minDistance;
				});

				if (!isTooClose) break;
				attempts++;
			} while (attempts < maxAttempts);

			// Always use unique ID format
			let newId;
			if (currentenv && currentenv.user) {
				newId = `${currentenv.user.networkId}_${Date.now()}`;
			} else {
				newId = nextStickmanId++;
			}

			const newStickman = createStickmanJoints(centerX, centerY, newId);
			enforceJointDistances(newStickman.joints);
			stickmen.push(newStickman);

			// Initialize frames
			baseFrames[newId] = deepClone(newStickman.joints);
			deltaFrames[newId] = [];
			currentFrameIndices[newId] = 0;

			const userColor = currentenv.user.colorvalue;
			stickmanUserColors[newId] = userColor;

			// Always broadcast in shared mode
			if (isShared && presence) {
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: 'new_stickman',
					content: {
						stickman: {
							id: newId,
							joints: newStickman.joints,
							baseFrame: baseFrames[newId],
							deltaFrames: deltaFrames[newId],
							currentFrameIndex: currentFrameIndices[newId]
						},
						color: userColor
					}
				});
			}

			selectedStickmanIndex = stickmen.length - 1;
			neckManuallyMoved = false;

			updateTimeline();
			updateRemoveButtonState();
			console.log(`Added new stickman with ID: ${newId}. Total: ${stickmen.length}`);
		}

		function confirmationModal(stickmanId, stickmanToRemove) {
			const modalOverlay = document.createElement('div');
			modalOverlay.className = 'modal-overlay';

			const modal = document.createElement('div');
			modal.className = 'modal-content';

			const header = document.createElement('div');
			header.className = 'modal-header';

			const headerContent = document.createElement('div');
			headerContent.style.display = 'flex';
			headerContent.style.alignItems = 'center';
			headerContent.style.gap = '8px';

			const warningIcon = document.createElement('div');
			warningIcon.style.backgroundImage = "url('./icons/emblem-warning.svg')";
			warningIcon.style.backgroundSize = '40px 40px';
			warningIcon.style.backgroundRepeat = 'no-repeat';
			warningIcon.style.backgroundPosition = 'center';
			warningIcon.style.width = '40px';
			warningIcon.style.height = '40px';

			const title = document.createElement('h3');
			title.textContent = l10n.get("Warning") || "Warning";
			title.className = 'modal-title';

			headerContent.appendChild(warningIcon);
			headerContent.appendChild(title);

			const body = document.createElement('div');
			body.className = 'modal-body';

			const message = document.createElement('p');
			message.textContent = l10n.get("ConfirmRemoval");
			message.className = 'modal-message';

			// button container
			const buttonContainer = document.createElement('div');
			buttonContainer.className = 'modal-button-container';

			// cancel button
			const cancelButton = document.createElement('button');
			cancelButton.className = 'modal-button';
			cancelButton.innerHTML = `
				<span class="modal-button-icon modal-button-icon-cancel"></span>${l10n.get("Cancel") || "Cancel"}
			`;

			// confirm button
			const confirmButton = document.createElement('button');
			confirmButton.className = 'modal-button modal-button-confirm';
			confirmButton.innerHTML = `
				<span class="modal-button-icon modal-button-icon-minus"></span>${l10n.get("Remove") || "Remove"}
			`;

			cancelButton.onclick = () => {
				document.body.removeChild(modalOverlay);
			};

			confirmButton.onclick = () => {
				document.body.removeChild(modalOverlay);

				if (stickmen.length > 1) {
					const stickmanId = stickmen[stickmanToRemove].id;

					// Broadcast removal in shared mode BEFORE removing locally
					if (isShared && presence) {
						broadcastStickmanRemoval(stickmanId);
					}

					// Remove from current stickmen array
					stickmen.splice(stickmanToRemove, 1);

					// Remove stickman frames
					delete baseFrames[stickmanId];
					delete deltaFrames[stickmanId];
					delete currentFrameIndices[stickmanId];
					delete stickmanUserColors[stickmanId];

					// Adjust selected stickman index if needed
					if (selectedStickmanIndex === stickmanToRemove) {
						selectedJoint = null;
						selectedStickmanIndex = stickmen.length > 0 ? 0 : -1;
					} else if (selectedStickmanIndex > stickmanToRemove) {
						selectedStickmanIndex--;
					}

					updateTimeline();
					updateRemoveButtonState();

					// If only one stickman remains, automatically exit removal mode
					if (stickmen.length <= 1) {
						exitRemovalMode();
					}
				} else {
					console.error("Cannot remove the last stickman. At least one stickman must remain.");
				}
			};

			// Close modal when clicking overlay
			modalOverlay.onclick = (e) => {
				if (e.target === modalOverlay) {
					document.body.removeChild(modalOverlay);
				}
			};

			// Assemble modal
			header.appendChild(headerContent);
			body.appendChild(message);
			buttonContainer.appendChild(cancelButton);
			buttonContainer.appendChild(confirmButton);
			body.appendChild(buttonContainer);
			modal.appendChild(header);
			modal.appendChild(body);
			modalOverlay.appendChild(modal);

			// Add to page
			document.body.appendChild(modalOverlay);
		}

		function removeSelectedStickman() {
			// Check if only one stickman remains
			if (stickmen.length <= 1) {
				console.log("Cannot remove the last stickman");
				return;
			}

			if (!isRemovalMode) {
				isRemovalMode = true;
				document.getElementById('minus-button').style.backgroundColor = '#808080';
				canvas.style.cursor = 'crosshair';
			} else {
				exitRemovalMode();
			}
		}

		function updateRemoveButtonState() {
			const minusButton = document.getElementById('minus-button');

			if (stickmen.length <= 1) {
				minusButton.disabled = true;
				minusButton.title = l10n.get("CannotRemoveLastStickman");
			} else {
				minusButton.disabled = false;
				minusButton.title = l10n.get("RemoveStickmanTooltip");
			}
		}

		function exitRemovalMode() {
			isRemovalMode = false;
			document.getElementById('minus-button').style.backgroundColor = '';
			canvas.style.cursor = 'default';
		}

		function updateMiddleJoint(stickmanIndex) {
			if (stickmanIndex >= 0 && stickmanIndex < stickmen.length && !neckManuallyMoved) {
				const joints = stickmen[stickmanIndex].joints;
				joints[11].x = (joints[1].x + joints[2].x) / 2;
				joints[11].y = (joints[1].y + joints[2].y) / 2;
			}
		}

		async function loadTemplate(templateName) {
			try {
				const response = await fetch(`js/templates/${templateName}.json`);
				if (!response.ok) {
					throw new Error(`Failed to load template: ${templateName}`);
				}
				const templateData = await response.json();

				// Create a new stickman with next ID
				const newStickmanId = nextStickmanId++;
				const newStickman = createStickmanJoints(canvas.width / 2, canvas.height / 2, newStickmanId);
				
				// Reset to single stickman
				stickmen = [newStickman];
				selectedStickmanIndex = 0;
				
				// Initialize delta structure for this stickman
				baseFrames = {};
				deltaFrames = {};
				currentFrameIndices = {};
				currentFrameIndices[newStickmanId] = 0;
				
				// Convert template frames to new format
				const templateFrames = JSON.parse(JSON.stringify(templateData.frames));
				if (templateFrames.length > 0) {
					// Process first frame as base frame
					let firstFrame = templateFrames[0];
					
					if (Array.isArray(firstFrame) && firstFrame.length > 0) {
						if (Array.isArray(firstFrame[0])) {
							baseFrames[newStickmanId] = firstFrame[0];
						} else if (firstFrame[0].joints) {
							baseFrames[newStickmanId] = firstFrame[0].joints;
						} else {
							baseFrames[newStickmanId] = firstFrame;
						}
					} else if (firstFrame.joints) {
						baseFrames[newStickmanId] = firstFrame.joints;
					} else {
						baseFrames[newStickmanId] = firstFrame;
					}
					
					// Ensure middle joint exists
					if (baseFrames[newStickmanId].length === 11) {
						baseFrames[newStickmanId].push({
							x: (baseFrames[newStickmanId][1].x + baseFrames[newStickmanId][2].x) / 2,
							y: (baseFrames[newStickmanId][1].y + baseFrames[newStickmanId][2].y) / 2,
							name: 'middle'
						});
					}
					
					// Process subsequent frames as deltas
					deltaFrames[newStickmanId] = [];
					for (let i = 1; i < templateFrames.length; i++) {
						let currentFrame = templateFrames[i];
						let previousFrame = templateFrames[i - 1];
						
						// Normalize frame structure
						let currentJoints, previousJoints;
						
						if (Array.isArray(currentFrame) && currentFrame.length > 0) {
							currentJoints = Array.isArray(currentFrame[0]) ? currentFrame[0] : 
								(currentFrame[0].joints ? currentFrame[0].joints : currentFrame);
						} else if (currentFrame.joints) {
							currentJoints = currentFrame.joints;
						} else {
							currentJoints = currentFrame;
						}
						
						if (Array.isArray(previousFrame) && previousFrame.length > 0) {
							previousJoints = Array.isArray(previousFrame[0]) ? previousFrame[0] : 
								(previousFrame[0].joints ? previousFrame[0].joints : previousFrame);
						} else if (previousFrame.joints) {
							previousJoints = previousFrame.joints;
						} else {
							previousJoints = previousFrame;
						}
						
						// Ensure middle joint exists in both frames
						if (currentJoints.length === 11) {
							currentJoints.push({
								x: (currentJoints[1].x + currentJoints[2].x) / 2,
								y: (currentJoints[1].y + currentJoints[2].y) / 2,
								name: 'middle'
							});
						}
						if (previousJoints.length === 11) {
							previousJoints.push({
								x: (previousJoints[1].x + previousJoints[2].x) / 2,
								y: (previousJoints[1].y + previousJoints[2].y) / 2,
								name: 'middle'
							});
						}
						
						// Calculate delta
						const delta = calculateDeltas(currentJoints, previousJoints);
						if (delta) {
							deltaFrames[newStickmanId].push(delta);
						}
					}
					
					// Update current stickman to base frame
					stickmen[0] = {
						id: newStickmanId,
						joints: JSON.parse(JSON.stringify(baseFrames[newStickmanId]))
					};
				}
				
				neckManuallyMoved = false;
				updateMiddleJoint(0);
				updateTimeline();
			} catch (error) {
				console.error('Error loading template:', error);
				createInitialStickman();
			}
		}

		// FRAME MANAGEMENT

		function addFrame() {
			// If no stickman is selected, add frame for all stickmen Otherwise, add frame only for selected stickman
			const targetStickmanIndices = selectedStickmanIndex >= 0 ?
				[selectedStickmanIndex] : stickmen.map((_, index) => index);

			// Filter to only include owned stickmen in shared mode
			const allowedIndices = targetStickmanIndices.filter(index => {
				if (!isShared || !presence) return true;

				const stickmanId = stickmen[index].id;
				return isStickmanOwned(stickmanId);
			});

			if (allowedIndices.length === 0) {
				console.log("No owned stickmen to add frames for");
				return;
			}

			allowedIndices.forEach(index => {
				updateMiddleJoint(index);

				const stickman = stickmen[index];
				const stickmanId = stickman.id;

				// Ensure current stickman joints have proper distances before processing
				enforceJointDistances(stickman.joints);

				if (!baseFrames[stickmanId]) {
					// First frame - create base frame
					baseFrames[stickmanId] = JSON.parse(JSON.stringify(stickman.joints));
					deltaFrames[stickmanId] = [];
					currentFrameIndices[stickmanId] = 0;
				} else {
					// Additional frame - calculate delta from current position
					const currentFrameIndex = currentFrameIndices[stickmanId];
					const previousFrame = reconstructFrameFromDeltas(stickmanId, currentFrameIndex);

					if (previousFrame) {
						const delta = calculateDeltas(stickman.joints, previousFrame.joints);
						if (delta) {
							deltaFrames[stickmanId].push(delta);
							// Update current frame index to the new frame
							const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
							currentFrameIndices[stickmanId] = totalFrames - 1;
						}
					}
				}
			});

			neckManuallyMoved = false;
			updateTimeline();
		}

		function saveCurrentFrame() {
			// If no stickman is selected or being manipulated, save all stickmen Otherwise, save only the selected stickman
			const targetStickmanIndices = selectedStickmanIndex >= 0 ? [selectedStickmanIndex] : stickmen.map((_, index) => index);
				
			targetStickmanIndices.forEach(index => {
				const stickman = stickmen[index];
				const stickmanId = stickman.id;
				
				// Skip if no frames for this stickman
				if (!baseFrames[stickmanId]) {
					return;
				}
				
				const isNeckOperation = (isRotating || isDragging) && selectedJoint && 
					stickmen[index] === stickman && 
					stickmen[index].joints.indexOf(selectedJoint) === 1;
				
				if (!isNeckOperation) {
					updateMiddleJoint(index);
				}
				
				// Enforce joint distance constraints before saving
				enforceJointDistances(stickman.joints);
				
				const currentFrameIndex = currentFrameIndices[stickmanId];
				const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
				
				if (currentFrameIndex === 0) {
					// Update base frame
					baseFrames[stickmanId] = JSON.parse(JSON.stringify(stickman.joints));
					
					// Recompute ALL deltas since base frame changed
					const newDeltas = [];
					for (let i = 1; i < totalFrames; i++) {
						const frame = reconstructFrameFromDeltas(stickmanId, i);
						const prevFrame = reconstructFrameFromDeltas(stickmanId, i - 1);
						
						if (frame && prevFrame) {
							const delta = calculateDeltas(frame.joints, prevFrame.joints);
							if (delta) {
								newDeltas.push(delta);
							}
						}
					}
					deltaFrames[stickmanId] = newDeltas;
					
				} else if (currentFrameIndex > 0) {
					// Update a delta frame - need to recompute this and all subsequent deltas
					const deltaIndex = currentFrameIndex - 1;
					
					if (deltaIndex >= 0 && deltaIndex < deltaFrames[stickmanId].length) {
						// First, temporarily store the current stickman position
						const currentJoints = JSON.parse(JSON.stringify(stickman.joints));
						
						// Get the previous frame
						const previousFrame = reconstructFrameFromDeltas(stickmanId, currentFrameIndex - 1);
						
						if (previousFrame) {
							// Calculate new delta for current frame
							const newDelta = calculateDeltas(currentJoints, previousFrame.joints);
							if (newDelta) {
								deltaFrames[stickmanId][deltaIndex] = newDelta;
							}
							
							// Now recompute all subsequent deltas
							for (let i = currentFrameIndex + 1; i < totalFrames; i++) {
								const nextFrameOld = reconstructFrameFromDeltas(stickmanId, i);
								const prevFrameNew = reconstructFrameFromDeltas(stickmanId, i - 1);
								
								if (nextFrameOld && prevFrameNew) {
									const subsequentDelta = calculateDeltas(nextFrameOld.joints, prevFrameNew.joints);
									if (subsequentDelta) {
										deltaFrames[stickmanId][i - 1] = subsequentDelta;
									}
								}
							}
						}
					}
				}
			});

			// Sync updates in shared mode
			if (isShared && selectedStickmanIndex >= 0) {
				const stickman = stickmen[selectedStickmanIndex];
				const stickmanId = stickman.id;

				if (isHost) {
					// Host broadcasts updates to all
					presence.sendMessage({
						type: 'stickman_update',
						stickmanId: stickmanId,
						baseFrame: baseFrames[stickmanId],
						deltaFrames: deltaFrames[stickmanId],
						currentFrameIndex: currentFrameIndices[stickmanId]
					});
				} else {
					// Non-hosts send updates only to host
					presence.sendMessage({
						type: 'stickman_update_request',
						stickmanId: stickmanId,
						baseFrame: baseFrames[stickmanId],
						deltaFrames: deltaFrames[stickmanId],
						currentFrameIndex: currentFrameIndices[stickmanId]
					});
				}
			}
		}

		// TIMELINE FUNCTIONS

		function updateTimeline() {
			const timeline = document.getElementById('timeline');
			timeline.innerHTML = '';
			
			// If no stickmen exist, don't show timeline
			if (stickmen.length === 0) {
				return;
			}
			
			// Get the currently selected stickman (or first one if none selected)
			const stickmanIndex = selectedStickmanIndex >= 0 ? selectedStickmanIndex : 0;
			const selectedStickman = stickmen[stickmanIndex];
			const stickmanId = selectedStickman.id;
			
			// Check ownership in shared mode
			let isOwnStickman = true;
			if (isShared && presence) {
				isOwnStickman = isStickmanOwned(stickmanId);
			}
			
			// Only show frames if user owns the stickman
			if (!isOwnStickman) {
				// For non-owned stickmen, show empty timeline
				return;
			}
			
			const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
			const currentFrameIndex = currentFrameIndices[stickmanId] || 0;
			
			// For each frame of the selected stickman, create a preview
			for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
				const frameContainer = document.createElement('div');
				frameContainer.className = 'frame-container';

				const frameData = reconstructFrameFromDeltas(stickmanId, frameIndex);
				const previewCanvas = createPreviewCanvas(frameData, frameIndex, stickmanId);
				const deleteBtn = createDeleteButton(frameIndex, stickmanId);

				previewCanvas.addEventListener('click', () => {
					if (isShared && presence) {
						if (!isStickmanOwned(stickmanId)) {
							console.log("Cannot switch frames of non-owned stickman");
							return;
						}
					}
					
					currentFrameIndices[stickmanId] = frameIndex;

					const newFrameData = reconstructFrameFromDeltas(stickmanId, frameIndex);
					if (newFrameData) {
						stickmen[stickmanIndex] = newFrameData;
						
						neckManuallyMoved = false; // Reset flag when switching frames
						updateMiddleJoint(stickmanIndex);
						updateTimeline();
						render();
					}
				});

				frameContainer.appendChild(previewCanvas);
				frameContainer.appendChild(deleteBtn);
				timeline.appendChild(frameContainer);
			}

			// Scroll to active frame inline
			const activeFrame = timeline.querySelector('.frame.active');
			if (activeFrame) {
				const timelineRect = timeline.getBoundingClientRect();
				const activeFrameRect = activeFrame.getBoundingClientRect();

				if (activeFrameRect.right > timelineRect.right || activeFrameRect.left < timelineRect.left) {
					activeFrame.scrollIntoView({
						behavior: 'smooth',
						block: 'nearest',
						inline: 'center'
					});
				}
			}
		}

		function createPreviewCanvas(frameData, index, stickmanId) {
			const previewCanvas = document.createElement('canvas');
			previewCanvas.width = 80;
			previewCanvas.height = 80;

			const isActive = index === currentFrameIndices[stickmanId];
			previewCanvas.className = `frame ${isActive ? 'active' : ''}`;

			const previewCtx = previewCanvas.getContext('2d');
			previewCtx.fillStyle = isActive ? '#e6f3ff' : '#ffffff';
			previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

			// Draw the stickman frame data
			if (frameData && frameData.joints) {
				const joints = frameData.joints;

				// Calculate bounds for this single stickman
				const stickmanHeight = Math.max(...joints.map(p => p.y)) - Math.min(...joints.map(p => p.y));
				const stickmanWidth = Math.max(...joints.map(p => p.x)) - Math.min(...joints.map(p => p.x));
				const scale = Math.min(40 / stickmanHeight, 40 / stickmanWidth);

				const centerX = (Math.max(...joints.map(p => p.x)) + Math.min(...joints.map(p => p.x))) / 2;
				const centerY = (Math.max(...joints.map(p => p.y)) + Math.min(...joints.map(p => p.y))) / 2;

				previewCtx.save();
				previewCtx.translate(previewCanvas.width / 2, previewCanvas.height / 2);
				previewCtx.scale(scale, scale);
				previewCtx.translate(-centerX, -centerY);

				// Draw stickman in preview
				drawStickmanPreview(previewCtx, joints);

				previewCtx.restore();
			}

			return previewCanvas;
		}

		function createDeleteButton(frameIndex, stickmanId) {
			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'delete-frame';
			deleteBtn.innerHTML = '';
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				
				if (isShared && presence) {
					if (!isStickmanOwned(stickmanId)) {
						console.log("Cannot delete frame of non-owned stickman");
						return;
					}
				}
				
				const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
				
				if (totalFrames > 1) {
					// Remove this frame using delta system
					if (frameIndex === 0) {
						// Removing base frame - promote second frame to base
						const secondFrame = reconstructFrameFromDeltas(stickmanId, 1);

						if (secondFrame) {
							baseFrames[stickmanId] = secondFrame.joints;

							// Remove first delta and recompute remaining deltas
							deltaFrames[stickmanId].shift();
							
							// Recompute all remaining deltas relative to new base
							const newDeltas = [];

							for (let i = 1; i < deltaFrames[stickmanId].length + 1; i++) {
								const currentFrame = reconstructFrameFromDeltas(stickmanId, i);
								const previousFrame = reconstructFrameFromDeltas(stickmanId, i - 1);

								if (currentFrame && previousFrame) {
									const delta = calculateDeltas(currentFrame.joints, previousFrame.joints);
									if (delta) newDeltas.push(delta);
								}
							}

							deltaFrames[stickmanId] = newDeltas;
						}
					} else {
						// Remove delta frame and rebase subsequent deltas
						rebaseDeltas(stickmanId, frameIndex);
					}
					
					// Adjust current frame index if needed
					const newTotalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
					currentFrameIndices[stickmanId] = Math.min(
						currentFrameIndices[stickmanId], 
						newTotalFrames - 1
					);
					
					// Find the stickman with this ID in the current stickmen array
					for (let i = 0; i < stickmen.length; i++) {
						if (stickmen[i].id === stickmanId) {
							const newFrameIndex = currentFrameIndices[stickmanId];
							const newFrameData = reconstructFrameFromDeltas(stickmanId, newFrameIndex);

							if (newFrameData) {
								stickmen[i] = newFrameData;
								neckManuallyMoved = false;
								updateMiddleJoint(i);
							}

							break;
						}
					}
					updateTimeline();
				}
			});
			return deleteBtn;
		}

		// DRAWING FUNCTIONS

		function drawStickmanPreview(ctx, joints) {
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 2;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';

			drawStickmanSkeleton(ctx, joints);

			ctx.fillStyle = '#ff0000';
			joints.forEach((joint, index) => {
				if (index === 11) 
					return; 
				ctx.beginPath();
				if (index === 0) {
					ctx.arc(joint.x, joint.y, 3, 0, Math.PI * 2);
				} else {
					ctx.arc(joint.x, joint.y, 2, 0, Math.PI * 2);
				}
				ctx.fill();
			});
		}

		function drawAllStickmen() {
			stickmen.forEach((stickman, stickmanIndex) => {
				drawStickman(stickman.joints, stickmanIndex);
			});
		}

		function drawStickman(joints, stickmanIndex) {
			const stickmanId = stickmen[stickmanIndex].id;
			const isOwnStickman = isStickmanOwned(stickmanId);
			
			// Apply remote offset if this is a remote stickman
			let displayJoints = joints;
			if (!isOwnStickman && remoteStickmanPositions[stickmanId]) {
				const offsetX = remoteStickmanPositions[stickmanId].offsetX || 0;
				const offsetY = remoteStickmanPositions[stickmanId].offsetY || 0;
				
				displayJoints = joints.map(joint => ({
					x: joint.x + offsetX,
					y: joint.y + offsetY,
					name: joint.name
				}));
			}
			
			// Draw with different style for remote stickmen
			if (!isOwnStickman) {
				// Get user color for remote stickman
				let userColor = null;
				if (stickmanUserColors[stickmanId]) {
					userColor = stickmanUserColors[stickmanId];
				}
				
				// Draw solid black skeleton for remote stickmen
				drawStickmanSkeleton(ctx, displayJoints, userColor, isOwnStickman);
				
				// Only show hip joint for dragging
				const hipJoint = displayJoints[2];
				ctx.fillStyle = '#00ff00';
				ctx.strokeStyle = '#00cc00';
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(hipJoint.x, hipJoint.y, 5, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
				
				return; // Skip normal drawing for remote stickmen
			}
			
			// Original drawing code for owned stickmen
			// skeleton first
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 3;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';

			// Get user color and ownership info
			let userColor = null;

			if (stickmanIndex < stickmen.length) {
				const stickmanId = stickmen[stickmanIndex].id;

				// Only get color for OTHER users' stickmen
				if (!isOwnStickman && stickmanUserColors[stickmanId]) {
					userColor = stickmanUserColors[stickmanId];
				}
			}

			drawStickmanSkeleton(ctx, displayJoints, userColor, isOwnStickman);

			// Show joints for selected stickman, or first stickman if none selected
			const shouldShowJoints = (selectedStickmanIndex >= 0)
				? stickmanIndex === selectedStickmanIndex
				: stickmanIndex === 0;

			// Only draw joints if the stickman is owned by current user (or not in shared mode)
			const canShowJoints = !isShared || isOwnStickman;

			if (shouldShowJoints && canShowJoints) {
				displayJoints.forEach((joint, index) => {
					if (index === 11)
						return; // Skip middle joint in regular drawing

					// Different colors for different joint types
					if (index === 2) {
						// Hip joint - drag anchor
						ctx.fillStyle = '#00ff00';
						ctx.strokeStyle = '#00cc00';
					} else if (index === 0) {
						// Head joint - always red for own stickmen in joint view
						ctx.fillStyle = '#ff0000';
						ctx.strokeStyle = '#cc0000';
					} else if (isRotationalJoint(index)) {
						// Rotational joints
						ctx.fillStyle = '#ff8800';
						ctx.strokeStyle = '#cc6600';
					} else {
						// Regular joints
						ctx.fillStyle = '#ff0000';
						ctx.strokeStyle = '#cc0000';
					}

					ctx.lineWidth = 1.5;
					ctx.beginPath();
					ctx.arc(joint.x, joint.y, 4, 0, Math.PI * 2);
					ctx.fill();
					ctx.stroke();
				});

				// Draw middle joint only for owned stickmen
				const middleJoint = displayJoints[11];
				ctx.fillStyle = '#ff8800';
				ctx.strokeStyle = '#cc6600';
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(middleJoint.x, middleJoint.y, 4, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
			} else if (shouldShowJoints && !isOwnStickman) {
				// For remote stickmen, only show the hip joint
				const hipJoint = displayJoints[2]; 
				ctx.fillStyle = '#00ff00'; 
				ctx.strokeStyle = '#00cc00';
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(hipJoint.x, hipJoint.y, 4, 0, Math.PI * 2); // Same size as owned stickmen
				ctx.fill();
				ctx.stroke();
			}
		}

		function drawStickmanSkeleton(ctx, joints, userColor = null, isOwnStickman = true) {
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 12;
			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';

			// body line
			ctx.beginPath();
			ctx.moveTo(joints[0].x, joints[0].y);
			ctx.lineTo(joints[1].x, joints[1].y);
			if (joints[11]) {
				ctx.lineTo(joints[11].x, joints[11].y);
			}
			ctx.lineTo(joints[2].x, joints[2].y);
			ctx.stroke();

			// left leg
			ctx.beginPath();
			ctx.moveTo(joints[2].x, joints[2].y); // hips
			ctx.lineTo(joints[3].x, joints[3].y); // left knee
			ctx.lineTo(joints[4].x, joints[4].y); // left foot
			ctx.stroke();

			// right leg
			ctx.beginPath();
			ctx.moveTo(joints[2].x, joints[2].y); // hips
			ctx.lineTo(joints[5].x, joints[5].y); // right knee
			ctx.lineTo(joints[6].x, joints[6].y); // right foot
			ctx.stroke();

			// left arm
			ctx.beginPath();
			ctx.moveTo(joints[1].x, joints[1].y); // body
			ctx.lineTo(joints[7].x, joints[7].y); // left elbow
			ctx.lineTo(joints[8].x, joints[8].y); // left hand
			ctx.stroke();

			// right arm
			ctx.beginPath();
			ctx.moveTo(joints[1].x, joints[1].y);    // body
			ctx.lineTo(joints[9].x, joints[9].y);    // right elbow
			ctx.lineTo(joints[10].x, joints[10].y);  // right hand
			ctx.stroke();

			// head circle - use color only for OTHER users' stickmen
			ctx.beginPath();
			ctx.arc(joints[0].x, joints[0].y, 17, 0, Math.PI * 2);
			if (!isOwnStickman && userColor) {
				// Other user's stickman - use their color
				ctx.fillStyle = userColor.stroke || '#000000';
			} else {
				// Own stickman - always black
				ctx.fillStyle = '#000000';
			}
			ctx.fill();

			if (!isOwnStickman && userColor) {
				ctx.beginPath();
				ctx.arc(joints[0].x, joints[0].y, 6, 0, Math.PI * 2);
				ctx.fillStyle = userColor.fill || userColor.stroke || '#ffffff';
				ctx.fill();

				// Add a small border to the center dot for better visibility
				ctx.beginPath();
				ctx.arc(joints[0].x, joints[0].y, 6, 0, Math.PI * 2);
				ctx.strokeStyle = '#ffffff';
				ctx.lineWidth = 1;
				ctx.stroke();
			}
			
			// Restore context state
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 12;
		}

		// HIERARCHICAL ROTATION SYSTEM

		function rotatePointAroundPivot(point, pivot, angle) {
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			const dx = point.x - pivot.x;
			const dy = point.y - pivot.y;
			
			return {
				x: pivot.x + (dx * cos - dy * sin),
				y: pivot.y + (dx * sin + dy * cos)
			};
		}

		function rotateJointHierarchy(stickmanIndex, pivotJointIndex, angle) {
			const joints = stickmen[stickmanIndex].joints;
			let pivot;
			let pivotJointIndex_actual; // The joint that acts as the actual rotation pivot
			
			// Determine the actual pivot point for rotation
			if (pivotJointIndex === 11) { 
				// middle joint rotates around hip
				pivot = joints[2];
				pivotJointIndex_actual = 2;
			} else if (pivotJointIndex === 1) { 
				// body/neck rotates around middle joint
				pivot = joints[11];
				pivotJointIndex_actual = 11;
			} else if (pivotJointIndex === 7 || pivotJointIndex === 9) { 
				// elbows rotate around body
				pivot = joints[1];
				pivotJointIndex_actual = 1;
			} else if (pivotJointIndex === 3 || pivotJointIndex === 5) { 
				// knees rotate around hip
				pivot = joints[2];
				pivotJointIndex_actual = 2;
			} else {
				pivot = joints[pivotJointIndex];
				pivotJointIndex_actual = pivotJointIndex;
			}

			// Store pivot position to prevent it from changing during rotation
			const fixedPivot = { 
				x: pivot.x, 
				y: pivot.y 
			};

			// Rotate all child joints recursively
			function rotateChildren(parentIndex, rotationAngle) {
				const childIndices = jointHierarchy[parentIndex] || [];
				
				childIndices.forEach(childIndex => {
					// Never rotate the pivot joint itself
					if (childIndex === pivotJointIndex_actual) return;
					
					const oldPos = { 
						x: joints[childIndex].x, 
						y: joints[childIndex].y 
					};
					const newPos = rotatePointAroundPivot(oldPos, fixedPivot, rotationAngle);
					joints[childIndex].x = newPos.x;
					joints[childIndex].y = newPos.y;
					
					// Recursively rotate children of this joint
					rotateChildren(childIndex, rotationAngle);
				});
			}

			// First rotate the selected joint itself around its pivot (except pivot joints)
			if (pivotJointIndex !== pivotJointIndex_actual) {
				const oldPos = { 
					x: joints[pivotJointIndex].x, 
					y: joints[pivotJointIndex].y 
				};
				const newPos = rotatePointAroundPivot(oldPos, fixedPivot, angle);
				joints[pivotJointIndex].x = newPos.x;
				joints[pivotJointIndex].y = newPos.y;
			}

			// Then rotate all children
			rotateChildren(pivotJointIndex, angle);

			// Ensure pivot joint position is preserved (especially important for middle joint)
			if (pivotJointIndex_actual < joints.length) {
				joints[pivotJointIndex_actual].x = fixedPivot.x;
				joints[pivotJointIndex_actual].y = fixedPivot.y;
			}
		}

		function getAngle(point1, point2) {
			return Math.atan2(point2.y - point1.y, point2.x - point1.x);
		}

		function isRotationalJoint(jointIndex) {
			// These joints support rotation with hierarchical movement
			return [1, 2, 3, 5, 7, 9, 11].includes(jointIndex);
		}

		function getRotationPivot(stickmanIndex, jointIndex) {
			const joints = stickmen[stickmanIndex].joints;
			
			// Define pivot mapping for rotational joints
			const pivotMap = {
				11: joints[2],  // middle joint rotates around hip
				1: { x: joints[11].x, y: joints[11].y },  // body/neck rotates around middle joint
				7: joints[1],   // left elbow rotates around body
				9: joints[1],   // right elbow rotates around body
				3: joints[2],   // left knee rotates around hip
				5: joints[2]    // right knee rotates around hip
			};
			
			return pivotMap[jointIndex] || joints[jointIndex]; // fallback to joint itself
		}

		// ANIMATION CONTROL

		function togglePlayPause() {
			if (isPlaying) {
				pause();
			} else {
				play();
			}
		}

		function play() {
			if (!isPlaying) {
				isPlaying = true;
				document.getElementById('play-pause-button').style.backgroundImage = "url('icons/pause.svg')";
				animate();
			}
		}

		function pause() {
			isPlaying = false;
			document.getElementById('play-pause-button').style.backgroundImage = "url('icons/play.svg')";
		}

		function animate() {
			if (!isPlaying) 
				return;

			stickmen.forEach((stickman, index) => {
				const stickmanId = stickman.id;
				const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
				
				if (totalFrames > 1) {
					// Only animate if there are multiple frames
					// Move to next frame for this stickman
					currentFrameIndices[stickmanId] = (currentFrameIndices[stickmanId] + 1) % totalFrames;
					const newFrameIndex = currentFrameIndices[stickmanId];

					const newFrameData = reconstructFrameFromDeltas(stickmanId, newFrameIndex);
					if (newFrameData) {
						stickmen[index] = newFrameData;
						updateMiddleJoint(index);
					}
				}
			});
			
			neckManuallyMoved = false; 
			updateTimeline();

			setTimeout(() => {
				requestAnimationFrame(animate);
			}, 1000 / (currentSpeed * 2));
		}

		// MOUSE INTERACTION

		function handleMouseDown(e) {
			const { mouseX, mouseY } = getCanvasCoordinates(e);
			const result = findJointAtPosition(mouseX, mouseY);

			if (isRemovalMode && result) {
				// Remove the clicked stickman - only allow removing own stickmen in shared mode
				const stickmanToRemove = result.stickmanIndex;
				const stickmanId = stickmen[stickmanToRemove].id;

				// Check ownership in shared mode
				if (isShared && presence) {
					if (!isStickmanOwned(stickmanId)) {
						console.log("Cannot remove other user's stickman");
						return; // Simply return without any action
					}
				}

				// Only show confirmation if there's more than one stickman AND the stickman has more than one frame
				const totalFrames = baseFrames[stickmanId] ? 1 + (deltaFrames[stickmanId] ? deltaFrames[stickmanId].length : 0) : 0;
				const shouldShowConfirmation = stickmen.length > 1 && totalFrames > 1;

				if (shouldShowConfirmation) {
					confirmationModal(stickmanId, stickmanToRemove);
				} else {
					// Directly remove without confirmation
					if (stickmen.length > 1) {
						// Broadcast removal in shared mode before removing locally
						if (isShared && presence) {
							broadcastStickmanRemoval(stickmanId);
						}

						stickmen.splice(stickmanToRemove, 1);

						// Remove stickman frames
						delete baseFrames[stickmanId];
						delete deltaFrames[stickmanId];
						delete currentFrameIndices[stickmanId];
						delete stickmanUserColors[stickmanId];

						// Adjust selected stickman index if needed
						if (selectedStickmanIndex === stickmanToRemove) {
							selectedJoint = null;
							selectedStickmanIndex = stickmen.length > 0 ? 0 : -1;
						} else if (selectedStickmanIndex > stickmanToRemove) {
							selectedStickmanIndex--;
						}

						updateTimeline();
						updateRemoveButtonState();

						// If only one stickman remains, automatically exit removal mode
						if (stickmen.length <= 1) {
							exitRemovalMode();
						}
					}
				}
				return;
			} if (isRemovalMode) {
				// Stay in removal mode when clicking on canvas - don't exit
				return;
			}

			// Normal selection 
			if (result) {
				const stickmanIndex = result.stickmanIndex;
				const stickmanId = stickmen[stickmanIndex].id;
				
				// Check ownership
				const isOwnStickman = isStickmanOwned(stickmanId);

				// For remote stickmen, only allow dragging via hip joint
				if (!isOwnStickman) {
					const selectedJointIndex = stickmen[stickmanIndex].joints.indexOf(result.joint);
					
					// Only allow dragging remote stickmen by the hip joint
					if (selectedJointIndex !== 2) {
						console.log("Can only drag remote stickmen by the hip joint");
						return;
					}

					selectedJoint = result.joint;
					selectedStickmanIndex = result.stickmanIndex;
					
					// Store original positions for local dragging only
					if (!remoteStickmanPositions[stickmanId]) {
						remoteStickmanPositions[stickmanId] = {
							offsetX: 0,
							offsetY: 0,
							originalJoints: deepClone(stickmen[stickmanIndex].joints)
						};
					} else {
						// Update original joints to current position
						remoteStickmanPositions[stickmanId].originalJoints = deepClone(stickmen[stickmanIndex].joints);
					}
					
					// Start remote stickman drag
					isDraggingRemote = true;
					isDraggingWhole = true;
					dragStartPos = {
						x: mouseX,
						y: mouseY
					};
					
					return;
				}

				const previousSelectedIndex = selectedStickmanIndex;
				selectedJoint = result.joint;
				selectedStickmanIndex = result.stickmanIndex;

				// Update timeline if selected stickman changed
				if (previousSelectedIndex !== selectedStickmanIndex) {
					updateTimeline();
				}

				const selectedJointIndex = stickmen[selectedStickmanIndex].joints.indexOf(selectedJoint);

				originalJoints = deepClone(stickmen[selectedStickmanIndex].joints);

				// create frame if none exists at current position for this stickman
				const stickman = stickmen[selectedStickmanIndex];
				const stickmanIdSelected = stickman.id;
				if (!baseFrames[stickmanIdSelected]) {
					updateMiddleJoint(selectedStickmanIndex);
					enforceJointDistances(stickman.joints);
					baseFrames[stickmanIdSelected] = deepClone(stickman.joints);
					deltaFrames[stickmanIdSelected] = [];
					currentFrameIndices[stickmanIdSelected] = 0;
					updateTimeline();
				}

				if (selectedJointIndex === 2) {
					// Hip joint - drag whole stickman
					isDraggingWhole = true;
					dragStartPos = {
						x: mouseX,
						y: mouseY
					};
				} else if (isRotationalJoint(selectedJointIndex)) {
					// Start rotation for hierarchical joints
					isRotating = true;
					rotationPivot = getRotationPivot(selectedStickmanIndex, selectedJointIndex);
					rotationStartAngle = getAngle(
						rotationPivot, {
						x: mouseX,
						y: mouseY
					}
					);
				} else {
					// Regular joint dragging for non-hierarchical joints (head, hands, feet)
					isDragging = true;
				}
			} else {
				const previousSelectedIndex = selectedStickmanIndex;
				selectedJoint = null;
				selectedStickmanIndex = -1;
				originalJoints = [];

				// Update timeline if selection was cleared
				if (previousSelectedIndex !== -1) {
					updateTimeline();
				}
			}
		}

		function handleMouseMove(e) {
			const { mouseX, mouseY } = getCanvasCoordinates(e);

			if (isDraggingRemote && selectedStickmanIndex >= 0) {
				// Drag remote stickman locally only
				const stickmanId = stickmen[selectedStickmanIndex].id;
				const remoteData = remoteStickmanPositions[stickmanId];
				
				if (!remoteData) return;
				
				const deltaX = mouseX - dragStartPos.x;
				const deltaY = mouseY - dragStartPos.y;
				
				// Update local offset
				remoteStickmanPositions[stickmanId].offsetX = deltaX;
				remoteStickmanPositions[stickmanId].offsetY = deltaY;
				
				// Apply offset to display position only (not original data)
				stickmen[selectedStickmanIndex].joints.forEach((joint, index) => {
					joint.x = remoteData.originalJoints[index].x + deltaX;
					joint.y = remoteData.originalJoints[index].y + deltaY;
				});
				
				// No broadcast for remote stickman movement - local only
				render();
			} else if (isDraggingWhole && selectedStickmanIndex >= 0) {
				// Drag entire stickman using hip as anchor
				const deltaX = mouseX - dragStartPos.x;
				const deltaY = mouseY - dragStartPos.y;

				stickmen[selectedStickmanIndex].joints.forEach((joint, index) => {
					joint.x = originalJoints[index].x + deltaX;
					joint.y = originalJoints[index].y + deltaY;
				});

				// Check if this is a remote stickman
				const stickmanId = stickmen[selectedStickmanIndex].id;
				const isOwnStickman = isStickmanOwned(stickmanId);

				if (isOwnStickman) {
					if (isShared && presence) {
						broadcastStickmanMovement(selectedStickmanIndex, 'drag_whole');
					}
					saveCurrentFrame();
					updateTimeline();
				} else {
					// For remote stickmen, broadcast the movement as remote movement
					if (isShared && presence) {
						broadcastRemoteStickmanMovement(selectedStickmanIndex, 'drag_whole');
					}
				}
			} else if (isRotating && selectedJoint && selectedStickmanIndex >= 0 && rotationPivot) {
				// Hierarchical rotation
				const currentAngle = getAngle(rotationPivot, { x: mouseX, y: mouseY });
				const angleDiff = currentAngle - rotationStartAngle;

				const selectedJointIndex = stickmen[selectedStickmanIndex].joints.indexOf(selectedJoint);

				// Reset to original positions before applying rotation
				stickmen[selectedStickmanIndex].joints.forEach((joint, index) => {
					joint.x = originalJoints[index].x;
					joint.y = originalJoints[index].y;
				});

				// Apply rotation
				rotateJointHierarchy(selectedStickmanIndex, selectedJointIndex, angleDiff);

				// Enforce joint distance constraints after rotation
				enforceJointDistances(stickmen[selectedStickmanIndex].joints);

				// Mark neck as manually moved if we're rotating the neck joint
				if (selectedJointIndex === 1) {
					neckManuallyMoved = true;
				}

				// Only update middle joint position if we're not rotating the neck
				if (selectedJointIndex !== 1) {
					updateMiddleJoint(selectedStickmanIndex);
				}

				// Broadcast real-time rotation in shared mode
				if (isShared && presence) {
					broadcastStickmanMovement(selectedStickmanIndex, 'rotate', {
						jointIndex: selectedJointIndex,
						angle: angleDiff
					});
				}

				saveCurrentFrame();
				updateTimeline();
			} else if (isDragging && selectedJoint && selectedStickmanIndex >= 0) {
				const selectedJointIndex = stickmen[selectedStickmanIndex].joints.indexOf(selectedJoint);

				selectedJoint.x = mouseX;
				selectedJoint.y = mouseY;

				// Mark neck as manually moved if we're dragging the neck joint
				if (selectedJointIndex === 1) {
					neckManuallyMoved = true;
				}

				enforceJointDistances(stickmen[selectedStickmanIndex].joints);

				// Update middle joint position only when hips moved
				if (selectedJointIndex === 2) {
					updateMiddleJoint(selectedStickmanIndex);
				}

				// Broadcast real-time joint movement in shared mode
				if (isShared && presence) {
					broadcastStickmanMovement(selectedStickmanIndex, 'drag_joint', {
						jointIndex: selectedJointIndex,
						position: { x: mouseX, y: mouseY }
					});
				}

				saveCurrentFrame();
				updateTimeline();
			}
		}

		function handleMouseUp() {
			const wasInteracting = isDragging || isDraggingWhole || isRotating || isDraggingRemote;

			if (isDraggingRemote && selectedStickmanIndex >= 0) {
				// For remote stickmen, keep the local offset but don't save to frames
				const stickmanId = stickmen[selectedStickmanIndex].id;
				console.log("Finished dragging remote stickman locally - position not saved");
			}

			isDragging = false;
			isDraggingWhole = false;
			isDraggingRemote = false;
			isRotating = false;
			rotationPivot = null;

			// Check if remote stickman
			let isRemoteStickman = false;
			if (selectedStickmanIndex >= 0 && isShared && presence) {
				const stickmanId = stickmen[selectedStickmanIndex].id;
				isRemoteStickman = !isStickmanOwned(stickmanId);
			}

			if (selectedStickmanIndex >= 0 && originalJoints.length > 0) {
				// Only save frames and broadcast for own stickmen
				if (!isRemoteStickman) {
					// Always save the current frame
					saveCurrentFrame();
					updateTimeline();

					// Send final position update in shared mode after interaction ends
					if (wasInteracting && isShared && presence) {
						broadcastStickmanFinalPosition(selectedStickmanIndex);
					}
				}
			}

			originalJoints = [];
		}

		function getCanvasCoordinates(e) {
			const rect = canvas.getBoundingClientRect();
			const scaleX = canvas.width / rect.width;
			const scaleY = canvas.height / rect.height;
			return {
				mouseX: (e.clientX - rect.left) * scaleX,
				mouseY: (e.clientY - rect.top) * scaleY
			};
		}

		function findJointAtPosition(x, y) {
			for (let stickmanIndex = stickmen.length - 1; stickmanIndex >= 0; stickmanIndex--) {
				const joints = stickmen[stickmanIndex].joints;
				const stickmanId = stickmen[stickmanIndex].id;
				const isOwnStickman = isStickmanOwned(stickmanId);

				// Apply remote offset for hit detection if it exists
				let hitTestJoints = joints;
				if (!isOwnStickman && remoteStickmanPositions[stickmanId]) {
					const offsetX = remoteStickmanPositions[stickmanId].offsetX || 0;
					const offsetY = remoteStickmanPositions[stickmanId].offsetY || 0;
					
					hitTestJoints = joints.map(joint => ({
						x: joint.x + offsetX,
						y: joint.y + offsetY,
						name: joint.name
					}));
				}

				// For remote stickmen, only check hip joint with larger hit area
				if (!isOwnStickman) {
					const hipJoint = hitTestJoints[2];
					const dx = hipJoint.x - x;
					const dy = hipJoint.y - y;
					const distance = Math.sqrt(dx * dx + dy * dy);
					
					// Larger hit area for remote stickman hip
					if (distance < 15) {
						return { 
							joint: joints[2], // Return original joint, not offset one
							stickmanIndex: stickmanIndex 
						};
					}
					continue;
				}

				// Define hit radii for different joint types
				const getHitRadius = (jointIndex) => {
					switch (jointIndex) {
						case 0: 
							return 15; // head - largest hit area
						case 2: 
							return 12; // hips - large for whole stickman drag
						case 11: 
							return 10; // middle - medium for rotation
						case 1: 
							return 10; // body/neck - medium for rotation
						default: 
							return 8;  // hands, feet, elbows, knees
					}
				};

				// Check joints in order of interaction priority
				const priorityOrder = [2, 11, 1, 0, 7, 9, 3, 5, 8, 10, 4, 6];
				
				for (const jointIndex of priorityOrder) {
					if (jointIndex >= hitTestJoints.length){ 
						continue;
					}

					const joint = hitTestJoints[jointIndex];
					const dx = joint.x - x;
					const dy = joint.y - y;
					const distance = Math.sqrt(dx * dx + dy * dy);
					const hitRadius = getHitRadius(jointIndex);

					if (distance < hitRadius) {
						return { 
							joint: joints[jointIndex], // Return original joint, not offset one
							stickmanIndex: stickmanIndex 
						};
					}
				}
			}
			return null;
		}

		// RENDERING LOOP

		function render() {
			ctx.clearRect(0, 0, canvas.width, canvas.height);

			// Handle empty canvas state
			if (stickmen.length === 0) {
				ctx.fillStyle = '#888888';
				ctx.font = '20px Arial';
				ctx.textAlign = 'center';
				ctx.fillText('Waiting for stickmen...', canvas.width / 2, canvas.height / 2);
				requestAnimationFrame(render);
				return;
			}

			// Draw onion skin of previous frame - only for selected stickman that is owned
			// do not show during playback or for remote stickmen
			if (!isPlaying && selectedStickmanIndex >= 0) {
				const stickmanId = stickmen[selectedStickmanIndex].id;
				
				// Only show onion skin for owned stickmen
				if (isStickmanOwned(stickmanId)) {
					const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
					const currentFrameIndex = currentFrameIndices[stickmanId] || 0;
					
					// Only show onion skin if there's a previous frame
					if (totalFrames > 1 && currentFrameIndex > 0) {
						const prevFrameIndex = currentFrameIndex - 1;
						const prevFrame = reconstructFrameFromDeltas(stickmanId, prevFrameIndex);
						
						if (prevFrame) {
							ctx.save();
							ctx.globalAlpha = 0.3;
							ctx.strokeStyle = '#0066cc';
							ctx.lineWidth = 2;
							ctx.lineCap = 'round';
							ctx.lineJoin = 'round';

							drawStickmanSkeleton(ctx, prevFrame.joints);

							ctx.fillStyle = '#0066cc';
							prevFrame.joints.forEach((joint, index) => {
								// Skip middle joint
								if (index === 11) 
									return;

								ctx.beginPath();
								if (index === 0) {
									ctx.arc(joint.x, joint.y, 4, 0, Math.PI * 2);
								} else {
									ctx.arc(joint.x, joint.y, 2, 0, Math.PI * 2);
								}
								ctx.fill();
							});

							ctx.restore();
						}
					}
				}
			}

			drawAllStickmen();
			requestAnimationFrame(render);
		}

		// EXPORT FUNCTIONALITY

		// Calculate bounding box for a single stickman
		function calculateStickmanBounds(joints) {
			if (!joints || joints.length === 0) return null;
			
			const xs = joints.map(joint => joint.x);
			const ys = joints.map(joint => joint.y);
			
			return {
				minX: Math.min(...xs),
				maxX: Math.max(...xs),
				minY: Math.min(...ys),
				maxY: Math.max(...ys)
			};
		}

		// Calculate global bounds across all stickmen and all frames
		function calculateGlobalBounds() {
			let globalMinX = Infinity;
			let globalMaxX = -Infinity;
			let globalMinY = Infinity;
			let globalMaxY = -Infinity;
			
			// Iterate through all stickmen and all their frames
			Object.keys(baseFrames).forEach(stickmanId => {
				const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
				
				for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
					const frameData = reconstructFrameFromDeltas(stickmanId, frameIndex);
					if (frameData && frameData.joints) {
						const bounds = calculateStickmanBounds(frameData.joints);
						if (bounds) {
							globalMinX = Math.min(globalMinX, bounds.minX);
							globalMaxX = Math.max(globalMaxX, bounds.maxX);
							globalMinY = Math.min(globalMinY, bounds.minY);
							globalMaxY = Math.max(globalMaxY, bounds.maxY);
						}
					}
				}
			});
			
			// Return null if no valid bounds found
			if (globalMinX === Infinity) 
				return null;
			
			return {
				minX: globalMinX,
				maxX: globalMaxX,
				minY: globalMinY,
				maxY: globalMaxY,
				width: globalMaxX - globalMinX,
				height: globalMaxY - globalMinY
			};
		}

		// Calculate optimal export bounds with fixed size and margin
		function calculateOptimalExportBounds(margin = 50) {
			const globalBounds = calculateGlobalBounds();
			if (!globalBounds) {
				// Fallback to canvas center if no stickmen
				return {
					x: canvas.width / 4,
					y: canvas.height / 4,
					width: canvas.width / 2,
					height: canvas.height / 2
				};
			}
			
			// Add margin around the content
			const boundedWidth = globalBounds.width + (margin * 2);
			const boundedHeight = globalBounds.height + (margin * 2);
			
			// Ensure minimum size for visibility
			const minSize = 200;
			const finalWidth = Math.max(boundedWidth, minSize);
			const finalHeight = Math.max(boundedHeight, minSize);
			
			// Calculate centered position
			const centerX = (globalBounds.minX + globalBounds.maxX) / 2;
			const centerY = (globalBounds.minY + globalBounds.maxY) / 2;
			
			const exportBounds = {
				x: centerX - finalWidth / 2,
				y: centerY - finalHeight / 2,
				width: finalWidth,
				height: finalHeight
			};
			
			// Ensure bounds don't go outside canvas
			exportBounds.x = Math.max(0, Math.min(exportBounds.x, canvas.width - exportBounds.width));
			exportBounds.y = Math.max(0, Math.min(exportBounds.y, canvas.height - exportBounds.height));
			
			return exportBounds;
		}

		function exportAnimation() {
			// Calculate optimal bounding box for export
			const exportBounds = calculateOptimalExportBounds(50); // 50px margin
			
			const recordCanvas = document.createElement('canvas');
			recordCanvas.width = exportBounds.width;
			recordCanvas.height = exportBounds.height;
			const recordCtx = recordCanvas.getContext('2d');

			const stream = recordCanvas.captureStream(15);
			const mediaRecorder = new MediaRecorder(stream, {
				mimeType: 'video/webm;codecs=vp9'
			});

			const chunks = [];
			mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
			mediaRecorder.onstop = () => {
				const blob = new Blob(chunks, { type: 'video/webm' });
				
				// Convert blob to data URL for journal storage
				const reader = new FileReader();
				reader.onload = function() {
					const dataURL = reader.result;
					saveVideoToJournal(dataURL);
				};
				reader.readAsDataURL(blob);
			};

			mediaRecorder.start();

			// Find the maximum number of frames across all stickmen
			let maxFrames = 0;
			Object.keys(baseFrames).forEach(stickmanId => {
				const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
				maxFrames = Math.max(maxFrames, totalFrames);
			});
			
			// Create a copy of current stickmen for animation
			let animationStickmen = JSON.parse(JSON.stringify(stickmen));
			let exportFrameIndices = {};
			
			// Initialize frame indices for export
			stickmen.forEach(stickman => {
				exportFrameIndices[stickman.id] = 0;
			});
			
			let currentExportFrame = 0;
			const renderFrame = () => {
				if (currentExportFrame >= maxFrames) {
					mediaRecorder.stop();
					return;
				}

				// Clear with white background
				recordCtx.fillStyle = '#ffffff';
				recordCtx.fillRect(0, 0, recordCanvas.width, recordCanvas.height);

				// Save context and set up clipping/translation for the bounding box
				recordCtx.save();
				
				// Translate to crop the content to our bounding box
				recordCtx.translate(-exportBounds.x, -exportBounds.y);

				// Update each stickman to its current frame for this export frame
				animationStickmen.forEach((stickman, index) => {
					const stickmanId = stickman.id;
					const totalFrames = baseFrames[stickmanId] ? 1 + deltaFrames[stickmanId].length : 0;
					
					if (totalFrames > 0) {
						// Only advance frame if this stickman has more frames
						if (exportFrameIndices[stickmanId] < totalFrames) {
							const frameIndex = exportFrameIndices[stickmanId];
							const frameData = reconstructFrameFromDeltas(stickmanId, frameIndex);
							
							if (frameData) {
								animationStickmen[index] = frameData;
								
								// Move to next frame for next export frame
								exportFrameIndices[stickmanId] = (exportFrameIndices[stickmanId] + 1) % totalFrames;
							}
						}
						
						// Draw the stickman in its current state
						recordCtx.strokeStyle = '#000';
						recordCtx.lineWidth = 8;
						
						// Get user color for shared mode
						const userColor = stickmanUserColors[stickmanId] || 
							((currentenv && currentenv.user && currentenv.user.colorvalue) 
								? currentenv.user.colorvalue 
								: null);
						
						drawStickmanSkeleton(recordCtx, animationStickmen[index].joints, userColor);
					}
				});

				// Restore context
				recordCtx.restore();

				currentExportFrame++;
				// Use current speed setting for export timing (same as animation playback)
				const exportDelay = 1000 / (currentSpeed * 2);
				setTimeout(() => requestAnimationFrame(renderFrame), exportDelay);
			};

			renderFrame();
		}

		function saveVideoToJournal(dataURL) {
			// Get the mimetype from the data URL
			const mimetype = dataURL.split(';')[0].split(':')[1];
			const type = mimetype.split('/')[0];
			
			// Create metadata for the video entry
			const metadata = {
				mimetype: mimetype,
				title: "Video by " + (currentenv && currentenv.user ? currentenv.user.name : "User"),
				activity: "org.olpcfrance.MediaViewerActivity",
				timestamp: new Date().getTime(),
				creation_time: new Date().getTime(),
				file_size: 0
			};

			// Save to datastore
			datastore.create(metadata, function(error, objectId) {
				if (error) {
					console.error("Error saving video to journal:", error);
					// Fallback to download if journal save fails
					const blob = dataURLtoBlob(dataURL);
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = 'stickman-animation.webm';
					a.click();
					URL.revokeObjectURL(url);
				} else {
					console.log("Video saved to journal successfully with ID:", objectId);
					humane.log(l10n.get("AnimationSavedToJournal") || "Animation has been successfully saved to your Journal!");
				}
			}, dataURL);
		}

		function dataURLtoBlob(dataURL) {
			const arr = dataURL.split(',');
			const mime = arr[0].match(/:(.*?);/)[1];
			const bstr = atob(arr[1]);
			let n = bstr.length;
			const u8arr = new Uint8Array(n);
			while (n--) {
				u8arr[n] = bstr.charCodeAt(n);
			}
			return new Blob([u8arr], { type: mime });
		}

		// JOURNAL IMPORT FUNCTIONALITY

		function importFromJournal() {
			journalchooser.show(function (entry) {
				// No selection
				if (!entry) {
					return;
				}

				// Get object content
				var dataentry = new datastore.DatastoreObject(entry.objectId);
				dataentry.loadAsText(function (err, metadata, jsonData) {
					if (err) {
						console.log("Error loading journal entry:", err);
						return;
					}

					if (!jsonData) {
						console.log("No data found in journal entry");
						return;
					}

					try {
						const savedData = JSON.parse(jsonData);

						// Check if savedData is valid
						if (!savedData || typeof savedData !== 'object') {
							console.log("Invalid data format - not an object");
							return;
						}

						// Validate that this is stickman data
						if (!savedData.baseFrames || !savedData.deltaFrames || !savedData.currentFrameIndices) {
							console.log("Invalid stickman data format - missing required properties");
							console.log("Available properties:", Object.keys(savedData));
							return;
						}

						// Import the stickman data
						const importedStickmen = [];
						const importedBaseFrames = {};
						const importedDeltaFrames = {};
						const importedCurrentFrameIndices = {};
						const importedStickmanUserColors = {};

						// Process each stickman from the imported data
						Object.keys(savedData.baseFrames).forEach(stickmanIdStr => {
							try {
								const stickmanId = stickmanIdStr;
								const frameIndex = savedData.currentFrameIndices[stickmanId] || 0;
								
								// Reconstruct the stickman from delta system
								const baseFrame = savedData.baseFrames[stickmanId];
								const deltaFramesList = savedData.deltaFrames[stickmanId] || [];
								
								if (baseFrame && Array.isArray(baseFrame)) {
									// Create new ID for imported stickman to avoid conflicts
									let newStickmanId;
									if (currentenv && currentenv.user) {
										newStickmanId = `${currentenv.user.networkId}_${Date.now()}_imported_${Object.keys(importedBaseFrames).length}`;
									} else {
										newStickmanId = nextStickmanId++;
									}

									// Copy the base frame and delta frames with new ID
									importedBaseFrames[newStickmanId] = deepClone(baseFrame);
									importedDeltaFrames[newStickmanId] = deepClone(deltaFramesList);
									importedCurrentFrameIndices[newStickmanId] = 0;

									// Assign current user's color to imported stickman
									if (currentenv && currentenv.user && currentenv.user.colorvalue) {
										importedStickmanUserColors[newStickmanId] = currentenv.user.colorvalue;
									}

									// Reconstruct the current frame
									const reconstructedFrame = reconstructFrame(newStickmanId, 0, importedBaseFrames, importedDeltaFrames);

									if (reconstructedFrame && reconstructedFrame.joints && Array.isArray(reconstructedFrame.joints)) {

										// Position the imported stickman at a safe location
										const centerX = canvas.width / 2 + (importedStickmen.length * 150) - 300;
										const centerY = canvas.height / 2;
										
										// Calculate offset to move stickman to new position
										const currentCenter = {
											x: (
												Math.max(...reconstructedFrame.joints.map(p => p.x)) + Math.min(...reconstructedFrame.joints.map(p => p.x))
											) / 2,
											y: (
												Math.max(...reconstructedFrame.joints.map(p => p.y)) + Math.min(...reconstructedFrame.joints.map(p => p.y))
											) / 2
										};
										
										const offsetX = centerX - currentCenter.x;
										const offsetY = centerY - currentCenter.y;

										// Apply offset to all joints
										reconstructedFrame.joints.forEach(joint => {
											if (joint && typeof joint.x === 'number' && typeof joint.y === 'number') {
												joint.x += offsetX;
												joint.y += offsetY;
											}
										});

										// Update base frame with new position
										importedBaseFrames[newStickmanId] = deepClone(reconstructedFrame.joints);

										// Recalculate all delta frames with new base position
										const newDeltas = [];
										for (let i = 0; i < deltaFramesList.length; i++) {
											const originalDelta = deltaFramesList[i];
											if (originalDelta && Array.isArray(originalDelta)) {
												// Apply the same offset to delta movements
												const adjustedDelta = originalDelta.map(delta => ({
													dx: delta.dx || 0,
													dy: delta.dy || 0,
													name: delta.name || 'unknown'
												}));
												newDeltas.push(adjustedDelta);
											}
										}
										importedDeltaFrames[newStickmanId] = newDeltas;

										importedStickmen.push(reconstructedFrame);
									} else {
										console.log("Could not reconstruct frame for stickman:", stickmanId);
									}
								} else {
									console.log("Invalid base frame for stickman:", stickmanId, baseFrame);
								}
							} catch (stickmanError) {
								console.log("Error processing individual stickman:", stickmanIdStr, stickmanError);
							}
						});

						if (importedStickmen.length > 0) {
							// Add imported stickmen to current animation
							stickmen.push(...importedStickmen);
							Object.assign(baseFrames, importedBaseFrames);
							Object.assign(deltaFrames, importedDeltaFrames);
							Object.assign(currentFrameIndices, importedCurrentFrameIndices);
							Object.assign(stickmanUserColors, importedStickmanUserColors);

							// Update middle joints for all imported stickmen
							const startIndex = stickmen.length - importedStickmen.length;
							for (let i = startIndex; i < stickmen.length; i++) {
								updateMiddleJoint(i);
							}

							// Select the first imported stickman
							selectedStickmanIndex = startIndex;

							updateTimeline();
							updateRemoveButtonState();
							render();

							humane.log((l10n.get("StickmanImported") || "Stickman imported successfully!"));

							console.log(`Imported ${importedStickmen.length} stickmen from journal`);
						} else {
							console.log("No valid stickmen found in the selected entry");
						}

					} catch (parseError) {
						console.log("Error parsing stickman data:", parseError);
						console.log("Raw data received:", jsonData ? jsonData.substring(0, 200) + "..." : "null");
					}
				});
			}, { activity: 'org.sugarlabs.Stickman' }); // Filter to show only Stickman entries
		}

		// VIDEO IMPORT FUNCTIONALITY WITH POSENET

		// Load PoseNet model with ResNet50 optimizations
		async function loadPoseNet() {
			if (!posenetModel) {
				try {
					console.log("Loading ResNet50 PoseNet model for high accuracy...");
					
					// Check if required dependencies are available
					if (!window.tf || !window.posenet) {
						throw new Error("TensorFlow.js or PoseNet not loaded");
					}

					// Load ResNet50 model
					posenetModel = await posenet.load(posenetConfig);
					console.log("ResNet50 PoseNet model loaded successfully");
					
					// Warm up the model with a dummy prediction for better performance
					const dummyCanvas = document.createElement('canvas');
					dummyCanvas.width = 513;
					dummyCanvas.height = 513;
					const dummyCtx = dummyCanvas.getContext('2d');
					dummyCtx.fillStyle = '#000000';
					dummyCtx.fillRect(0, 0, 513, 513);
					
					await posenetModel.estimateSinglePose(dummyCanvas);
					console.log("ResNet50 model warmed up and ready");
					
				} catch (error) {
					console.error("Error loading ResNet50 PoseNet model:", error);
					
					// Fallback to MobileNetV1 if ResNet50 fails
					try {
						console.log("ResNet50 failed, falling back to MobileNetV1...");
						const fallbackConfig = {
							architecture: 'MobileNetV1',
							outputStride: 16,
							inputResolution: 257,
							multiplier: 0.75
						};
						
						posenetModel = await posenet.load(fallbackConfig);
						console.log("Fallback to MobileNetV1 successful");
					} catch (fallbackError) {
						console.error("Both ResNet50 and MobileNetV1 failed:", fallbackError);
						throw new Error("Failed to load any PoseNet model");
					}
				}
			}
			return posenetModel;
		}

		// Convert PoseNet keypoints to stickman joint format with ResNet50 optimized thresholds
		function convertPoseToStickman(pose, centerX, centerY) {
			const keypoints = pose.keypoints;
			
			function getKeypoint(name) {
				return keypoints.find(kp => kp.part === name);
			}

			function getKeypointPosition(name, fallback = null) {
				const kp = getKeypoint(name);
				// Lower threshold to capture more keypoints and detect more poses
				if (kp && kp.score > 0.1) { // Reduced threshold for more detections
					return { x: kp.position.x, y: kp.position.y, score: kp.score };
				}
				return fallback;
			}

			// Get essential keypoints with fallbacks
			const nose = getKeypointPosition('nose');
			const leftShoulder = getKeypointPosition('leftShoulder');
			const rightShoulder = getKeypointPosition('rightShoulder');
			const leftHip = getKeypointPosition('leftHip');
			const rightHip = getKeypointPosition('rightHip');

			// More lenient validation - require either nose OR at least one hip for valid pose
			if (!nose && !leftHip && !rightHip) {
				console.log("Missing essential keypoints for pose conversion (need at least nose or hip)");
				return null;
			}

			// Calculate hip center (use available hip if only one detected)
			let hipCenter;
			if (leftHip && rightHip) {
				hipCenter = {
					x: (leftHip.x + rightHip.x) / 2,
					y: (leftHip.y + rightHip.y) / 2
				};
			} else if (leftHip) {
				hipCenter = { x: leftHip.x, y: leftHip.y };
			} else {
				hipCenter = { x: rightHip.x, y: rightHip.y };
			}

			// Calculate shoulder center
			let shoulderCenter;
			if (leftShoulder && rightShoulder) {
				shoulderCenter = {
					x: (leftShoulder.x + rightShoulder.x) / 2,
					y: (leftShoulder.y + rightShoulder.y) / 2
				};
			} else if (leftShoulder) {
				shoulderCenter = { x: leftShoulder.x, y: leftShoulder.y };
			} else if (rightShoulder) {
				shoulderCenter = { x: rightShoulder.x, y: rightShoulder.y };
			} else {
				// Estimate shoulder position based on nose and hip
				shoulderCenter = {
					x: nose.x,
					y: nose.y + (hipCenter.y - nose.y) * 0.4
				};
			}

			// Calculate scale based on detected body size
			const detectedHeight = Math.abs(hipCenter.y - nose.y);
			const standardHeight = 80; // Head to hip distance in stickman
			const scale = detectedHeight > 20 ? standardHeight / detectedHeight : 1;

			// Create joints array with standard stickman proportions
			const joints = [];

			// Apply scaling and translation to center the stickman
			function transformPoint(x, y) {
				return {
					x: centerX + (x - hipCenter.x) * scale,
					y: centerY + (y - hipCenter.y) * scale
				};
			}

			// 0 - head
			const headPos = transformPoint(nose.x, nose.y);
			joints[0] = { x: headPos.x, y: headPos.y, name: 'head' };

			// 1 - body/neck
			const bodyPos = transformPoint(shoulderCenter.x, shoulderCenter.y);
			joints[1] = { x: bodyPos.x, y: bodyPos.y, name: 'body' };

			// 2 - hips
			joints[2] = { x: centerX, y: centerY, name: 'hips' };

			// 11 - middle (calculate first for reference)
			joints[11] = {
				x: (joints[1].x + joints[2].x) / 2,
				y: (joints[1].y + joints[2].y) / 2,
				name: 'middle'
			};

			// Generate other joints with fallback to standard positions
			const standardPositions = createStandardJointPositions(centerX, centerY);

			// Left leg
			const leftKnee = getKeypointPosition('leftKnee');
			const leftAnkle = getKeypointPosition('leftAnkle');
			
			if (leftKnee && leftKnee.score > 0.15) {
				const kneePos = transformPoint(leftKnee.x, leftKnee.y);
				joints[3] = { x: kneePos.x, y: kneePos.y, name: 'leftKnee' };
			} else {
				joints[3] = standardPositions[3];
			}

			if (leftAnkle && leftAnkle.score > 0.15) {
				const anklePos = transformPoint(leftAnkle.x, leftAnkle.y);
				joints[4] = { x: anklePos.x, y: anklePos.y, name: 'leftFoot' };
			} else {
				joints[4] = standardPositions[4];
			}

			// Right leg
			const rightKnee = getKeypointPosition('rightKnee');
			const rightAnkle = getKeypointPosition('rightAnkle');
			
			if (rightKnee && rightKnee.score > 0.15) {
				const kneePos = transformPoint(rightKnee.x, rightKnee.y);
				joints[5] = { x: kneePos.x, y: kneePos.y, name: 'rightKnee' };
			} else {
				joints[5] = standardPositions[5];
			}

			if (rightAnkle && rightAnkle.score > 0.15) {
				const anklePos = transformPoint(rightAnkle.x, rightAnkle.y);
				joints[6] = { x: anklePos.x, y: anklePos.y, name: 'rightFoot' };
			} else {
				joints[6] = standardPositions[6];
			}

			// Arms with more lenient detection
			const leftElbow = getKeypointPosition('leftElbow');
			const leftWrist = getKeypointPosition('leftWrist');
			const rightElbow = getKeypointPosition('rightElbow');
			const rightWrist = getKeypointPosition('rightWrist');

			// Left arm
			if (leftElbow && leftElbow.score > 0.1) {
				const elbowPos = transformPoint(leftElbow.x, leftElbow.y);
				joints[7] = { x: elbowPos.x, y: elbowPos.y, name: 'leftElbow' };
			} else {
				joints[7] = standardPositions[7];
			}

			if (leftWrist && leftWrist.score > 0.1) {
				const wristPos = transformPoint(leftWrist.x, leftWrist.y);
				joints[8] = { x: wristPos.x, y: wristPos.y, name: 'leftHand' };
			} else {
				joints[8] = standardPositions[8];
			}

			// Right arm
			if (rightElbow && rightElbow.score > 0.1) {
				const elbowPos = transformPoint(rightElbow.x, rightElbow.y);
				joints[9] = { x: elbowPos.x, y: elbowPos.y, name: 'rightElbow' };
			} else {
				joints[9] = standardPositions[9];
			}

			if (rightWrist && rightWrist.score > 0.1) {
				const wristPos = transformPoint(rightWrist.x, rightWrist.y);
				joints[10] = { x: wristPos.x, y: wristPos.y, name: 'rightHand' };
			} else {
				joints[10] = standardPositions[10];
			}

			// Enforce joint constraints lightly
			enforceBasicConstraints(joints);

			return joints;
		}

		// Create standard joint positions as fallback
		function createStandardJointPositions(centerX, centerY) {
			return [
				{ x: centerX, y: centerY - 65, name: 'head' },
				{ x: centerX, y: centerY - 45, name: 'body' },
				{ x: centerX, y: centerY + 15, name: 'hips' },
				{ x: centerX - 15, y: centerY + 55, name: 'leftKnee' },
				{ x: centerX - 20, y: centerY + 95, name: 'leftFoot' },
				{ x: centerX + 15, y: centerY + 55, name: 'rightKnee' },
				{ x: centerX + 20, y: centerY + 95, name: 'rightFoot' },
				{ x: centerX - 25, y: centerY - 35, name: 'leftElbow' },
				{ x: centerX - 40, y: centerY - 5, name: 'leftHand' },
				{ x: centerX + 25, y: centerY - 35, name: 'rightElbow' },
				{ x: centerX + 40, y: centerY - 5, name: 'rightHand' },
				{ x: centerX, y: centerY - 15, name: 'middle' }
			];
		}

		// Light constraint enforcement to prevent extreme poses
		function enforceBasicConstraints(joints) {
			const maxLimbLength = 60;
			const minLimbLength = 20;

			// Check critical connections
			const connections = [
				[0, 1], [1, 11], [11, 2], // body chain
				[2, 3], [3, 4], [2, 5], [5, 6], // legs
				[1, 7], [7, 8], [1, 9], [9, 10] // arms
			];

			connections.forEach(([from, to]) => {
				const joint1 = joints[from];
				const joint2 = joints[to];
				
				if (!joint1 || !joint2) return;
				
				const dx = joint2.x - joint1.x;
				const dy = joint2.y - joint1.y;
				const distance = Math.sqrt(dx * dx + dy * dy);
				
				if (distance > maxLimbLength) {
					const ratio = maxLimbLength / distance;
					joint2.x = joint1.x + dx * ratio;
					joint2.y = joint1.y + dy * ratio;
				} else if (distance < minLimbLength && distance > 0) {
					const ratio = minLimbLength / distance;
					joint2.x = joint1.x + dx * ratio;
					joint2.y = joint1.y + dy * ratio;
				}
			});
		}

		// Show spinner modal during video processing
		function showSpinnerModal() {
			const modal = document.createElement('div');
			modal.id = 'video-processing-modal';
			modal.style.cssText = `
				position: fixed;
				top: 0;
				left: 0;
				width: 100%;
				height: 100%;
				background: rgba(0, 0, 0, 0.7);
				display: flex;
				justify-content: center;
				align-items: center;
				z-index: 10000;
			`;

			const content = document.createElement('div');
			content.style.cssText = `
				background: white;
				padding: 30px;
				border-radius: 10px;
				text-align: center;
				box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
				max-width: 300px;
			`;

			const spinner = document.createElement('img');
			spinner.src = 'icons/spinner-light.gif';
			spinner.style.cssText = `
				width: 64px;
				height: 64px;
				margin-bottom: 20px;
			`;

			const title = document.createElement('h3');
			title.textContent = l10n.get("ProcessingVideo") || "Processing Video";
			title.style.cssText = `
				margin: 0 0 10px 0;
				color: #333;
				font-size: 18px;
			`;

			const message = document.createElement('p');
			message.textContent = l10n.get("PleaseWait") || "Please wait while we analyze your video...";
			message.style.cssText = `
				margin: 0;
				color: #666;
				font-size: 14px;
			`;

			content.appendChild(spinner);
			content.appendChild(title);
			content.appendChild(message);
			modal.appendChild(content);
			document.body.appendChild(modal);

			return modal;
		}

		// Hide spinner modal
		function hideSpinnerModal(modal) {
			if (modal && modal.parentNode) {
				modal.parentNode.removeChild(modal);
			}
		}

		// video import
		async function importVideoAnimation() {
			try {
				journalchooser.show(function (entry) {
					// No selection
					if (!entry) {
						return;
					}

					// Get object content
					var dataentry = new datastore.DatastoreObject(entry.objectId);
					dataentry.loadAsText(function (err, metadata, data) {
						if (err) {
							console.log("Error loading journal entry:", err);
							humane.log(l10n.get("VideoLoadError") || "Error loading video from journal");
							return;
						}

						const mimeType = metadata && (metadata.mime_type || metadata.mimetype);
						if (mimeType && mimeType.startsWith('video/')) {
							if (typeof dataentry.load === 'function') {
								// For video files, we need to load as binary data
								dataentry.load(function(err, metadata, binaryData) {
									if (err) {
										console.log("Error loading video data:", err);
										humane.log(l10n.get("VideoLoadError") || "Error loading video data");
										return;
									}

									try {
										// Convert binary data to blob
										const blob = new Blob([binaryData], { type: mimeType });
										processVideoFile(blob);
									} catch (error) {
										console.error('Error processing video from journal:', error);
										humane.log(l10n.get("VideoProcessingError") || "Error processing video file");
									}
								});
							} else if (typeof dataentry.loadAsDataURL === 'function') {
								dataentry.loadAsDataURL(function(err, metadata, dataURL) {
									if (err) {
										console.log("Error loading video data URL:", err);
										humane.log(l10n.get("VideoLoadError") || "Error loading video data");
										return;
									}

									try {
										// Convert data URL to blob
										fetch(dataURL)
											.then(res => res.blob())
											.then(blob => {
												processVideoFile(blob);
											})
											.catch(error => {
												console.error('Error converting data URL to blob:', error);
												humane.log(l10n.get("VideoProcessingError") || "Error processing video file");
											});
									} catch (error) {
										console.error('Error processing video from journal:', error);
										humane.log(l10n.get("VideoProcessingError") || "Error processing video file");
									}
								});
							} else if (data && data.length > 0) {
								try {
									// Try to treat the text data as base64 or data URL
									if (data.startsWith('data:')) {
										// It's already a data URL
										fetch(data)
											.then(res => res.blob())
											.then(blob => {
												processVideoFile(blob);
											})
											.catch(error => {
												console.error('Error converting text data URL to blob:', error);
												humane.log(l10n.get("VideoProcessingError") || "Error processing video file");
											});
									} else {
										// Try base64 decode
										const binaryString = atob(data);
										const bytes = new Uint8Array(binaryString.length);
										for (let i = 0; i < binaryString.length; i++) {
											bytes[i] = binaryString.charCodeAt(i);
										}
										const blob = new Blob([bytes], { type: mimeType });
										processVideoFile(blob);
									}
								} catch (error) {
									console.error('Error processing text data as video:', error);
									humane.log(l10n.get("VideoProcessingError") || "Error processing video file");
								}
							} else {
								humane.log(l10n.get("VideoLoadError") || "Cannot load video data from this entry");
							}
						} else {
							humane.log(l10n.get("NotVideoFile") || "Selected file is not a video");
						}
					});
				}, {
					mimetype: '%video/'
				});

			} catch (error) {
				console.error('Error importing video from journal:', error);
				humane.log(l10n.get("VideoImportError") || "Error importing video from journal");
			}
		}

		// Process the selected video file
		async function processVideoFile(file) {
			// Show spinner modal
			const spinnerModal = showSpinnerModal();

			try {
				// Load PoseNet model if not already loaded
				await loadPoseNet();

				// Create video element
				const video = document.createElement('video');
				video.src = URL.createObjectURL(file);
				video.muted = true;
				video.style.display = 'none';
				document.body.appendChild(video);

				return new Promise((resolve, reject) => {
					video.addEventListener('loadedmetadata', async () => {
						try {
							const frames = await extractFramesFromVideo(video);
							document.body.removeChild(video);
							URL.revokeObjectURL(video.src);

							hideSpinnerModal(spinnerModal);

							if (frames.length > 0) {
								// Show preview modal only after processing is complete
								await showVideoPreview(frames, file.name);
							} else {
								humane.log(l10n.get("NoFramesDetected") || "No pose detected in video");
							}
							resolve();
						} catch (error) {
							document.body.removeChild(video);
							URL.revokeObjectURL(video.src);
							hideSpinnerModal(spinnerModal);
							reject(error);
						}
					});

					video.addEventListener('error', () => {
						document.body.removeChild(video);
						URL.revokeObjectURL(video.src);
						hideSpinnerModal(spinnerModal);
						reject(new Error('Failed to load video'));
					});
				});
			} catch (error) {
				hideSpinnerModal(spinnerModal);
				throw error;
			}
		}

		// Extract frames from video and convert to stickman poses
		// Extract frames from video with ResNet50 optimizations
		async function extractFramesFromVideo(video) {
			const frames = [];
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			
			// Set canvas size to optimal ResNet50 input size for better accuracy
			canvas.width = 513;  // ResNet50 optimal input size
			canvas.height = 513;

			const duration = video.duration;
			const frameRate = 10; // Increased to 10 fps for smoother animation
			const frameInterval = 1 / frameRate;

			// Center position for stickman
			const centerX = 200; 
			const centerY = 200;

			video.currentTime = 0;

			console.log(`Processing video with ResNet50 - ${duration.toFixed(2)}s duration, ${frameRate} fps`);

			let lastPoseKeypoints = null; // Track last pose to detect duplicates

			for (let time = 0; time < duration; time += frameInterval) {
				try {
					video.currentTime = time;
					
					// Wait for video to seek to the correct time with timeout
					await new Promise((resolve, reject) => {
						let attempts = 0;
						const maxAttempts = 50; // Maximum wait attempts
						
						const checkTime = () => {
							attempts++;
							if (Math.abs(video.currentTime - time) < 0.05) { // Tighter tolerance
								resolve();
							} else if (attempts >= maxAttempts) {
								console.warn(`Video seek timeout at ${time.toFixed(2)}s`);
								resolve(); // Continue anyway
							} else {
								requestAnimationFrame(checkTime);
							}
						};
						checkTime();
					});

					// Force a small delay to ensure frame is rendered
					await new Promise(resolve => setTimeout(resolve, 10));

					// Draw current frame to canvas with optimal sizing for ResNet50
					ctx.clearRect(0, 0, canvas.width, canvas.height);
					
					// Calculate aspect ratio to maintain video proportions
					const videoAspect = video.videoWidth / video.videoHeight;
					const canvasAspect = canvas.width / canvas.height;
					
					let drawWidth, drawHeight, offsetX, offsetY;
					if (videoAspect > canvasAspect) {
						drawWidth = canvas.width;
						drawHeight = canvas.width / videoAspect;
						offsetX = 0;
						offsetY = (canvas.height - drawHeight) / 2;
					} else {
						drawWidth = canvas.height * videoAspect;
						drawHeight = canvas.height;
						offsetX = (canvas.width - drawWidth) / 2;
						offsetY = 0;
					}
					
					ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);

					// Store the video frame as ImageData for preview
					const videoFrameData = ctx.getImageData(0, 0, canvas.width, canvas.height);

					// Use ResNet50 for pose estimation with lower thresholds for more detection
					const poses = await posenetModel.estimateMultiplePoses(canvas, {
						flipHorizontal: false,
						maxDetections: 1,
						scoreThreshold: 0.1, // Lower threshold to detect more poses
						nmsRadius: 20
					});

					if (poses.length > 0 && poses[0].score > 0.15) { // Lower minimum score to capture more frames
						// Check if this pose is significantly different from the last one
						const currentPose = poses[0];
						let isDuplicatePose = false;
						
						if (lastPoseKeypoints) {
							// Compare key landmarks to detect duplicate poses
							const threshold = 8; // Reduced threshold - more sensitive to smaller movements
							let similarityCount = 0;
							const keyLandmarks = ['nose', 'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];
							let totalComparisons = 0;
							
							for (const landmark of keyLandmarks) {
								const lastKp = lastPoseKeypoints.find(kp => kp.part === landmark);
								const currentKp = currentPose.keypoints.find(kp => kp.part === landmark);
								
								if (lastKp && currentKp && lastKp.score > 0.1 && currentKp.score > 0.1) {
									totalComparisons++;
									const distance = Math.sqrt(
										Math.pow(lastKp.position.x - currentKp.position.x, 2) + 
										Math.pow(lastKp.position.y - currentKp.position.y, 2)
									);
									if (distance < threshold) {
										similarityCount++;
									}
								}
							}
							
							// Only consider it duplicate if ALL detected landmarks are very similar
							// AND we have at least 3 landmarks to compare
							isDuplicatePose = totalComparisons >= 3 && similarityCount === totalComparisons;
						}
						
						if (!isDuplicatePose) {
							const stickmanJoints = convertPoseToStickman(currentPose, centerX, centerY);
							if (stickmanJoints) {
								// Store both the video frame and the stickman data
								frames.push({
									joints: stickmanJoints,
									videoFrame: videoFrameData,
									pose: currentPose,
									timestamp: time
								});
								console.log(`✓ Frame ${frames.length} processed at ${time.toFixed(2)}s - Score: ${currentPose.score.toFixed(3)}`);
								
								// Update last pose for comparison
								lastPoseKeypoints = currentPose.keypoints;
							}
						} else {
							console.log(`Frame skipped at ${time.toFixed(2)} - Duplicate pose detected`);
						}
					} else {
						console.log(`Frame skipped at ${time.toFixed(2)} - Low score or No pose detected`);
					}

				} catch (error) {
					console.warn('Error processing frame at time', time, error);
					continue;
				}
			}

			console.log(`ResNet50 video processing complete - ${frames.length} high-quality frames extracted`);
			return frames;
		}

		// Show preview modal before adding animation to canvas
		async function showVideoPreview(frames, filename) {
			const modalOverlay = document.createElement('div');
			modalOverlay.className = 'modal-overlay';

			const modal = document.createElement('div');
			modal.className = 'modal-content';
			modal.style.cssText = `
				max-width: 900px;
				width: 90%;
				max-height: 90vh;
				overflow-y: auto;
			`;

			const header = document.createElement('div');
			header.className = 'modal-header-preview';

			const title = document.createElement('h3');
			title.textContent = l10n.get("VideoPreview") || "Video Pose Mapping Preview";
			title.className = 'modal-title';
			title.style.cssText = `
				text-align: center;
				margin-bottom: 15px;
			`;

			const body = document.createElement('div');
			body.className = 'modal-body-preview';

			// Create container for side-by-side canvases
			const canvasContainer = document.createElement('div');
			canvasContainer.style.cssText = `
				display: flex;
				justify-content: center;
				gap: 20px;
				margin-bottom: 15px;
				flex-wrap: wrap;
			`;

			// Original video canvas
			const videoCanvas = document.createElement('canvas');
			videoCanvas.id = 'video-preview-canvas';
			videoCanvas.width = 320;
			videoCanvas.height = 240;
			videoCanvas.style.cssText = `
				border: 2px solid #007acc;
				border-radius: 8px;
				background: #f5f5f5;
			`;

			const videoLabel = document.createElement('div');
			videoLabel.textContent = 'Original Video + Pose Detection';
			videoLabel.style.cssText = `
				text-align: center;
				font-size: 12px;
				color: #007acc;
				font-weight: bold;
				margin-bottom: 10px;
			`;

			const videoSection = document.createElement('div');
			videoSection.appendChild(videoLabel);
			videoSection.appendChild(videoCanvas);

			// Stickman canvas
			const stickmanCanvas = document.createElement('canvas');
			stickmanCanvas.id = 'stickman-preview-canvas';
			stickmanCanvas.width = 320;
			stickmanCanvas.height = 240;
			stickmanCanvas.style.cssText = `
				border: 2px solid #ff6600;
				border-radius: 8px;
				background: white;
			`;

			const stickmanLabel = document.createElement('div');
			stickmanLabel.textContent = 'Generated Stickman Animation';
			stickmanLabel.style.cssText = `
				text-align: center;
				font-size: 12px;
				color: #ff6600;
				font-weight: bold;
				margin-bottom: 10px;
			`;

			const stickmanSection = document.createElement('div');
			stickmanSection.appendChild(stickmanLabel);
			stickmanSection.appendChild(stickmanCanvas);

			canvasContainer.appendChild(videoSection);
			canvasContainer.appendChild(stickmanSection);

			// Frame counter container
			const frameCounterContainer = document.createElement('div');
			frameCounterContainer.style.cssText = `
				text-align: center;
				margin-bottom: 10px;
			`;

			const frameCounter = document.createElement('span');
			frameCounter.style.cssText = `
				font-size: 14px;
				color: #333;
				font-weight: bold;
			`;
			frameCounter.innerHTML = `Frame: <span id="frame-number">1</span> / ${frames.length}`;
			frameCounterContainer.appendChild(frameCounter);

			// Pose confidence display
			const confidenceContainer = document.createElement('div');
			confidenceContainer.style.cssText = `
				text-align: center;
				margin-bottom: 15px;
			`;

			const confidenceDisplay = document.createElement('span');
			confidenceDisplay.id = 'confidence-display';
			confidenceDisplay.style.cssText = `
				font-size: 12px;
				color: #666;
				background: #f0f0f0;
				padding: 4px 8px;
				border-radius: 4px;
			`;
			confidenceContainer.appendChild(confidenceDisplay);

			// Controls container
			const controlsContainer = document.createElement('div');
			controlsContainer.style.cssText = 'text-align: center; margin-bottom: 15px;';

			const playBtn = document.createElement('button');
			playBtn.innerHTML = `
				<img src="icons/play.svg" style="width: 16px; height: 16px; margin-right: 5px; vertical-align: middle;">
				${l10n.get("Play") || "Play"}
			`;
			playBtn.style.cssText = 'margin: 0 5px; padding: 8px 12px; display: inline-flex; align-items: center; background: #007acc; color: white; border: none; border-radius: 4px; cursor: pointer;';

			const prevBtn = document.createElement('button');
			prevBtn.innerHTML = '⏮ Previous';
			prevBtn.style.cssText = 'margin: 0 5px; padding: 8px 12px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer;';

			const nextBtn = document.createElement('button');
			nextBtn.innerHTML = 'Next ⏭';
			nextBtn.style.cssText = 'margin: 0 5px; padding: 8px 12px; background: #666; color: white; border: none; border-radius: 4px; cursor: pointer;';

			controlsContainer.appendChild(prevBtn);
			controlsContainer.appendChild(playBtn);
			controlsContainer.appendChild(nextBtn);

			// Button container
			const buttonContainer = document.createElement('div');
			buttonContainer.className = 'modal-button-container';

			// Cancel button
			const cancelButton = document.createElement('button');
			cancelButton.className = 'modal-button';
			cancelButton.innerHTML = `
				<span class="modal-button-icon modal-button-icon-cancel"></span>${l10n.get("Cancel") || "Cancel"}
			`;

			// Add button
			const addButton = document.createElement('button');
			addButton.className = 'modal-button modal-button-confirm';
			addButton.innerHTML = `
				<span class="modal-button-icon modal-button-icon-ok"></span>${l10n.get("AddToCanvas") || "Add to Canvas"}
			`;

			// Assemble modal structure
			header.appendChild(title);
			
			body.appendChild(canvasContainer);
			body.appendChild(frameCounterContainer);
			body.appendChild(confidenceContainer);
			body.appendChild(controlsContainer);

			buttonContainer.appendChild(cancelButton);
			buttonContainer.appendChild(addButton);

			modal.appendChild(header);
			modal.appendChild(body);
			modal.appendChild(buttonContainer);
			modalOverlay.appendChild(modal);
			document.body.appendChild(modalOverlay);

			// Set up preview animation
			const videoCtx = videoCanvas.getContext('2d');
			const stickmanCtx = stickmanCanvas.getContext('2d');
			const frameDisplay = document.getElementById('frame-number');
			const confidenceDisplayElement = document.getElementById('confidence-display');
			
			let currentFrame = 0;
			let isPlaying = false;
			let animationId = null;

			// Draw keypoints on video frame
			function drawPoseKeypoints(ctx, pose, scaleX, scaleY) {
				const keypoints = pose.keypoints;
				
				// Draw keypoint connections first
				const connections = [
					['leftShoulder', 'rightShoulder'],
					['leftShoulder', 'leftElbow'],
					['leftElbow', 'leftWrist'],
					['rightShoulder', 'rightElbow'],
					['rightElbow', 'rightWrist'],
					['leftShoulder', 'leftHip'],
					['rightShoulder', 'rightHip'],
					['leftHip', 'rightHip'],
					['leftHip', 'leftKnee'],
					['leftKnee', 'leftAnkle'],
					['rightHip', 'rightKnee'],
					['rightKnee', 'rightAnkle'],
					['nose', 'leftShoulder'],
					['nose', 'rightShoulder']
				];

				ctx.strokeStyle = '#00ff00';
				ctx.lineWidth = 2;
				
				connections.forEach(([start, end]) => {
					const startPoint = keypoints.find(kp => kp.part === start);
					const endPoint = keypoints.find(kp => kp.part === end);
					
					if (startPoint && endPoint && startPoint.score > 0.3 && endPoint.score > 0.3) {
						ctx.beginPath();
						ctx.moveTo(startPoint.position.x * scaleX, startPoint.position.y * scaleY);
						ctx.lineTo(endPoint.position.x * scaleX, endPoint.position.y * scaleY);
						ctx.stroke();
					}
				});

				// Draw keypoints
				keypoints.forEach(keypoint => {
					if (keypoint.score > 0.3) {
						const x = keypoint.position.x * scaleX;
						const y = keypoint.position.y * scaleY;
						
						// Color code by confidence
						if (keypoint.score > 0.8) {
							ctx.fillStyle = '#00ff00'; // High confidence - green
						} else if (keypoint.score > 0.5) {
							ctx.fillStyle = '#ffff00'; // Medium confidence - yellow
						} else {
							ctx.fillStyle = '#ff6600'; // Low confidence - orange
						}
						
						ctx.beginPath();
						ctx.arc(x, y, 4, 0, Math.PI * 2);
						ctx.fill();
						
						// Add keypoint label
						ctx.fillStyle = '#000';
						ctx.font = '10px Arial';
						ctx.fillText(keypoint.part, x + 6, y - 6);
					}
				});
			}

			// Draw frame function
			function drawPreviewFrame(frameIndex) {
				if (frameIndex >= frames.length) return;
				
				const frameData = frames[frameIndex];
				const { joints, videoFrame, pose, timestamp } = frameData;

				// Clear canvases
				videoCtx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
				stickmanCtx.clearRect(0, 0, stickmanCanvas.width, stickmanCanvas.height);

				// Draw original video frame
				const tempCanvas = document.createElement('canvas');
				tempCanvas.width = videoFrame.width;
				tempCanvas.height = videoFrame.height;
				const tempCtx = tempCanvas.getContext('2d');
				tempCtx.putImageData(videoFrame, 0, 0);

				// Scale video to fit canvas
				const scaleX = videoCanvas.width / videoFrame.width;
				const scaleY = videoCanvas.height / videoFrame.height;
				const scale = Math.min(scaleX, scaleY);
				
				const drawWidth = videoFrame.width * scale;
				const drawHeight = videoFrame.height * scale;
				const offsetX = (videoCanvas.width - drawWidth) / 2;
				const offsetY = (videoCanvas.height - drawHeight) / 2;

				videoCtx.drawImage(tempCanvas, offsetX, offsetY, drawWidth, drawHeight);

				// Draw pose keypoints on video
				videoCtx.save();
				videoCtx.translate(offsetX, offsetY);
				videoCtx.scale(scale, scale);
				drawPoseKeypoints(videoCtx, pose, 1, 1);
				videoCtx.restore();

				// Draw stickman on right canvas
				stickmanCtx.fillStyle = '#ffffff';
				stickmanCtx.fillRect(0, 0, stickmanCanvas.width, stickmanCanvas.height);
				
				// Center the stickman in the canvas
				const stickmanOffsetX = stickmanCanvas.width / 2;
				const stickmanOffsetY = stickmanCanvas.height / 2;
				
				const centeredJoints = joints.map(joint => ({
					x: joint.x - 200 + stickmanOffsetX,
					y: joint.y - 200 + stickmanOffsetY,
					name: joint.name
				}));

				// Draw stickman
				drawStickmanPreview(stickmanCtx, centeredJoints);

				// Update displays
				if (frameDisplay) {
					frameDisplay.textContent = frameIndex + 1;
				}
				
				if (confidenceDisplayElement) {
					const confidence = (pose.score * 100).toFixed(1);
					confidenceDisplayElement.textContent = `Pose Confidence: ${confidence}% | Time: ${timestamp.toFixed(2)}s`;
				}
			}

			// Animation loop
			function animate() {
				if (!isPlaying) return;
				
				drawPreviewFrame(currentFrame);
				currentFrame = (currentFrame + 1) % frames.length;
				
				animationId = setTimeout(() => {
					requestAnimationFrame(animate);
				}, 200); // 5 FPS preview
			}

			// Initial frame
			drawPreviewFrame(0);

			// Event listeners
			playBtn.addEventListener('click', () => {
				isPlaying = !isPlaying;
				if (isPlaying) {
					animate();
					playBtn.innerHTML = `
						<img src="icons/pause.svg" style="width: 16px; height: 16px; margin-right: 5px; vertical-align: middle;">
						${l10n.get("Pause") || "Pause"}
					`;
				} else {
					if (animationId) clearTimeout(animationId);
					playBtn.innerHTML = `
						<img src="icons/play.svg" style="width: 16px; height: 16px; margin-right: 5px; vertical-align: middle;">
						${l10n.get("Play") || "Play"}
					`;
				}
			});

			prevBtn.addEventListener('click', () => {
				if (animationId) clearTimeout(animationId);
				isPlaying = false;
				playBtn.innerHTML = `
					<img src="icons/play.svg" style="width: 16px; height: 16px; margin-right: 5px; vertical-align: middle;">
					${l10n.get("Play") || "Play"}
				`;
				currentFrame = Math.max(0, currentFrame - 1);
				drawPreviewFrame(currentFrame);
			});

			nextBtn.addEventListener('click', () => {
				if (animationId) clearTimeout(animationId);
				isPlaying = false;
				playBtn.innerHTML = `
					<img src="icons/play.svg" style="width: 16px; height: 16px; margin-right: 5px; vertical-align: middle;">
					${l10n.get("Play") || "Play"}
				`;
				currentFrame = Math.min(frames.length - 1, currentFrame + 1);
				drawPreviewFrame(currentFrame);
			});

			cancelButton.addEventListener('click', () => {
				if (animationId) clearTimeout(animationId);
				document.body.removeChild(modalOverlay);
			});

			addButton.addEventListener('click', () => {
				if (animationId) clearTimeout(animationId);
				document.body.removeChild(modalOverlay);
				// Extract just the joints for the animation
				const jointFrames = frames.map(frame => frame.joints);
				addVideoAnimationToCanvas(jointFrames);
			});

			modalOverlay.addEventListener('click', (e) => {
				if (e.target === modalOverlay) {
					if (animationId) clearTimeout(animationId);
					document.body.removeChild(modalOverlay);
				}
			});
		}

		// Add the video animation frames to canvas as a new stickman
		function addVideoAnimationToCanvas(frames) {
			if (frames.length === 0) return;

			// Create new stickman ID
			let newStickmanId;
			if (currentenv && currentenv.user) {
				newStickmanId = `${currentenv.user.networkId}_${Date.now()}`;
			} else {
				newStickmanId = nextStickmanId++;
			}

			// Ensure all frames have proper joint distances
			frames.forEach(frame => enforceJointDistances(frame));

			// Create new stickman with first frame
			const newStickman = {
				id: newStickmanId,
				joints: deepClone(frames[0])
			};

			stickmen.push(newStickman);

			// Set up base frame and deltas
			baseFrames[newStickmanId] = deepClone(frames[0]);
			deltaFrames[newStickmanId] = [];
			currentFrameIndices[newStickmanId] = 0;

			// Calculate deltas for subsequent frames
			for (let i = 1; i < frames.length; i++) {
				const delta = calculateDeltas(frames[i], frames[i - 1]);
				if (delta) {
					deltaFrames[newStickmanId].push(delta);
				}
			}

			// Associate with current user's color
			if (currentenv && currentenv.user && currentenv.user.colorvalue) {
				stickmanUserColors[newStickmanId] = currentenv.user.colorvalue;
			}

			// Select the new stickman
			selectedStickmanIndex = stickmen.length - 1;
			neckManuallyMoved = false;

			// Broadcast in shared mode
			if (isShared && presence) {
				presence.sendMessage(presence.getSharedInfo().id, {
					user: presence.getUserInfo(),
					action: 'new_stickman',
					content: {
						stickman: {
							id: newStickmanId,
							joints: newStickman.joints,
							baseFrame: baseFrames[newStickmanId],
							deltaFrames: deltaFrames[newStickmanId],
							currentFrameIndex: currentFrameIndices[newStickmanId]
						},
						color: stickmanUserColors[newStickmanId]
					}
				});
			}

			updateTimeline();
			updateRemoveButtonState();
			render();

			humane.log(`${l10n.get("VideoAnimationImported") || "Video animation imported successfully!"} (${frames.length} ${l10n.get("Frames") || "frames"})`);
		}

		// function for reconstructing frames with custom base/delta frames
		function reconstructFrame(stickmanId, frameIndex, customBaseFrames = null, customDeltaFrames = null) {
			const baseFramesSource = customBaseFrames || baseFrames;
			const deltaFramesSource = customDeltaFrames || deltaFrames;

			if (!baseFramesSource[stickmanId] || frameIndex < 0) {
				return null;
			}
			
			if (frameIndex === 0) {
				// First frame is always the base 
				return {
					id: stickmanId,
					joints: deepClone(baseFramesSource[stickmanId])
				};
			}
			
			if (!deltaFramesSource[stickmanId] || frameIndex - 1 >= deltaFramesSource[stickmanId].length) {
				return null;
			}
			
			// Start with base frame and apply deltas incrementally
			let currentJoints = deepClone(baseFramesSource[stickmanId]);
			
			for (let i = 0; i < frameIndex; i++) {
				if (deltaFramesSource[stickmanId][i]) {
					currentJoints = applyDeltas(currentJoints, deltaFramesSource[stickmanId][i]);
					// Enforce joint distance constraints after each delta application
					enforceJointDistances(currentJoints);
				}
			}
			
			return {
				id: stickmanId,
				joints: currentJoints
			};
		}

		// START APPLICATION
		
		// Process localize event
		window.addEventListener("localized", function() {
			console.log("Localization initialized");
			translateToolbarButtons();
		});
		
		activity.setup();
		initializeAnimator();
	});
});