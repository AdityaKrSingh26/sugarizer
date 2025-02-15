class StickmanAnimator {
	constructor() {
		this.canvas = document.getElementById('canvas');
		this.ctx = this.canvas.getContext('2d');
		this.frames = [];
		this.currentFrame = 0;
		this.isPlaying = false;
		this.speed = 1;
		this.joints = [];
		this.selectedJoint = null;
		this.isDragging = false;

		this.initCanvas();
		this.initEvents();
		this.createDefaultStickman();
		this.addFrame();
		this.render();

		// Add new button for creating new animation
		document.getElementById('newBtn').addEventListener('click', () => this.createNew());

		this.constraints = [
			{ joint1: 0, joint2: 1, distance: 40 },    // head to body
			{ joint1: 1, joint2: 2, distance: 25 },    // body to hips
			{ joint1: 2, joint2: 3, distance: 30 },    // hips to left knee
			{ joint1: 3, joint2: 4, distance: 25 },    // left knee to foot
			{ joint1: 2, joint2: 5, distance: 30 },    // hips to right knee
			{ joint1: 5, joint2: 6, distance: 25 },    // right knee to foot
			{ joint1: 1, joint2: 7, distance: 30 },    // body to left elbow
			{ joint1: 7, joint2: 8, distance: 20 },    // left elbow to hand
			{ joint1: 1, joint2: 9, distance: 30 },    // body to right elbow
			{ joint1: 9, joint2: 10, distance: 20 }    // right elbow to hand
		];

		// Add templates button to initEvents
		this.templates = {
			run: this.createRunningAnimation(),
			dance: this.createDanceAnimation(),
			// jump: this.createJumpAnimation(),
			// wave: this.createWaveAnimation()
		};
	}

	initCanvas() {
		this.resizeCanvas();
		window.addEventListener('resize', () => this.resizeCanvas());
	}

	resizeCanvas() {
		this.canvas.width = this.canvas.parentElement.clientWidth - 32;
		this.canvas.height = this.canvas.parentElement.clientHeight - 200;
	}

	initEvents() {
		// Canvas events
		this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
		this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
		this.canvas.addEventListener('mouseup', () => this.handleMouseUp());

		// Control buttons
		document.getElementById('playBtn').addEventListener('click', () => this.play());
		document.getElementById('pauseBtn').addEventListener('click', () => this.pause());
		document.getElementById('addFrame').addEventListener('click', () => this.addFrame());
		document.getElementById('exportBtn').addEventListener('click', () => this.exportAnimation());

		// Speed control
		document.getElementById('speed').addEventListener('input', (e) => {
			this.speed = parseFloat(e.target.value);
			document.getElementById('speedValue').textContent = this.speed + 'x';
		});

		// Template buttons
		document.getElementById('runBtn').addEventListener('click', () => this.loadTemplate('run'));
		document.getElementById('danceBtn').addEventListener('click', () => this.loadTemplate('dance'));
		document.getElementById('jumpBtn').addEventListener('click', () => this.loadTemplate('jump'));
		document.getElementById('waveBtn').addEventListener('click', () => this.loadTemplate('wave'));

	}

	createNew() {
		// Reset frames array
		this.frames = [];

		// Reset current frame
		this.currentFrame = 0;

		// Reset to default stickman position
		this.createDefaultStickman();

		// Add initial frame
		this.addFrame();

		// Update timeline display
		this.updateTimeline();

		// Stop any ongoing animation
		this.pause();
	}

	loadTemplate(templateName) {
		if (this.templates[templateName]) {
			this.frames = JSON.parse(JSON.stringify(this.templates[templateName]));
			this.currentFrame = 0;
			this.updateTimeline();
		}
	}

	createDefaultStickman() {
		this.joints = [
			{ x: 200, y: 160, name: 'head' },
			{ x: 200, y: 200, name: 'body' },
			{ x: 200, y: 225, name: 'hips' },         // Central hip joint
			{ x: 170, y: 250, name: 'leftKnee' },     // Left knee
			{ x: 170, y: 275, name: 'leftFoot' },     // Left foot
			{ x: 230, y: 250, name: 'rightKnee' },    // Right knee
			{ x: 230, y: 275, name: 'rightFoot' },    // Right foot
			{ x: 170, y: 200, name: 'leftElbow' },    // Left elbow
			{ x: 170, y: 220, name: 'leftHand' },     // Left hand
			{ x: 230, y: 200, name: 'rightElbow' },   // Right elbow
			{ x: 230, y: 220, name: 'rightHand' }     // Right hand
		];
	}

	constrainJoints() {
		const iterations = 5; // More iterations = more rigid constraints

		for (let i = 0; i < iterations; i++) {
			this.constraints.forEach(constraint => {
				const joint1 = this.joints[constraint.joint1];
				const joint2 = this.joints[constraint.joint2];

				// Calculate current distance
				const dx = joint2.x - joint1.x;
				const dy = joint2.y - joint1.y;
				const currentDistance = Math.sqrt(dx * dx + dy * dy);

				// Skip if distance is already correct
				if (currentDistance === constraint.distance) return;

				// Calculate the difference from desired distance
				const difference = (constraint.distance - currentDistance) / currentDistance;

				// Move joints to maintain constraint
				const offsetX = dx * 0.5 * difference;
				const offsetY = dy * 0.5 * difference;

				joint1.x -= offsetX;
				joint1.y -= offsetY;
				joint2.x += offsetX;
				joint2.y += offsetY;
			});
		}
	}

	handleMouseDown(e) {
		const rect = this.canvas.getBoundingClientRect();
		const mouseX = e.clientX - rect.left;
		const mouseY = e.clientY - rect.top;

		// Find the closest joint within 10 pixels
		this.selectedJoint = this.joints.find(joint => {
			const dx = joint.x - mouseX;
			const dy = joint.y - mouseY;
			return Math.sqrt(dx * dx + dy * dy) < 10;
		});

		if (this.selectedJoint) {
			this.isDragging = true;
		}
	}

	handleMouseMove(e) {
		if (this.isDragging && this.selectedJoint) {
			const rect = this.canvas.getBoundingClientRect();
			this.selectedJoint.x = e.clientX - rect.left;
			this.selectedJoint.y = e.clientY - rect.top;

			// Apply constraints after moving a joint
			this.constrainJoints();

			this.saveCurrentFrame();
		}
	}

	handleMouseUp() {
		this.isDragging = false;
		this.selectedJoint = null;
	}

	addFrame() {
		const frameData = JSON.parse(JSON.stringify(this.joints));
		this.frames.push(frameData);
		this.currentFrame = this.frames.length - 1;
		this.updateTimeline();
	}

	saveCurrentFrame() {
		if (this.currentFrame >= 0) {
			this.frames[this.currentFrame] = JSON.parse(JSON.stringify(this.joints));
		}
	}

	updateTimeline() {
		const timeline = document.getElementById('timeline');
		timeline.innerHTML = '';

		this.frames.forEach((frame, index) => {
			const frameContainer = document.createElement('div');
			frameContainer.className = `frame-container`;

			// Create preview canvas
			const previewCanvas = document.createElement('canvas');
			previewCanvas.width = 60;
			previewCanvas.height = 60;
			previewCanvas.className = `frame ${index === this.currentFrame ? 'active' : ''}`;

			// Draw preview
			const previewCtx = previewCanvas.getContext('2d');

			// Set background
			previewCtx.fillStyle = '#ffffff';
			previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

			// Calculate scaling factor based on the stickman size
			const stickmanHeight = Math.max(...frame.map(p => p.y)) - Math.min(...frame.map(p => p.y));
			const stickmanWidth = Math.max(...frame.map(p => p.x)) - Math.min(...frame.map(p => p.x));
			const scale = Math.min(40 / stickmanHeight, 40 / stickmanWidth);

			// Calculate center point of the stickman
			const centerX = (Math.max(...frame.map(p => p.x)) + Math.min(...frame.map(p => p.x))) / 2;
			const centerY = (Math.max(...frame.map(p => p.y)) + Math.min(...frame.map(p => p.y))) / 2;

			// Transform context to center and scale the stickman
			previewCtx.save();
			previewCtx.translate(previewCanvas.width / 2, previewCanvas.height / 2);
			previewCtx.scale(scale, scale);
			previewCtx.translate(-centerX, -centerY);

			// Draw stickman preview
			previewCtx.strokeStyle = '#000';
			previewCtx.lineWidth = 2;

			// Draw body
			previewCtx.beginPath();
			previewCtx.moveTo(frame[0].x, frame[0].y);
			previewCtx.lineTo(frame[1].x, frame[1].y);
			previewCtx.lineTo(frame[2].x, frame[2].y);
			previewCtx.stroke();

			// Draw legs
			previewCtx.beginPath();
			previewCtx.moveTo(frame[2].x, frame[2].y);
			previewCtx.lineTo(frame[3].x, frame[3].y);
			previewCtx.lineTo(frame[4].x, frame[4].y);
			previewCtx.stroke();

			previewCtx.beginPath();
			previewCtx.moveTo(frame[2].x, frame[2].y);
			previewCtx.lineTo(frame[5].x, frame[5].y);
			previewCtx.lineTo(frame[6].x, frame[6].y);
			previewCtx.stroke();

			// Draw arms
			previewCtx.beginPath();
			previewCtx.moveTo(frame[1].x, frame[1].y);
			previewCtx.lineTo(frame[7].x, frame[7].y);
			previewCtx.lineTo(frame[8].x, frame[8].y);
			previewCtx.stroke();

			previewCtx.beginPath();
			previewCtx.moveTo(frame[1].x, frame[1].y);
			previewCtx.lineTo(frame[9].x, frame[9].y);
			previewCtx.lineTo(frame[10].x, frame[10].y);
			previewCtx.stroke();

			// Draw head
			previewCtx.beginPath();
			previewCtx.arc(frame[0].x, frame[0].y, 8, 0, Math.PI * 2);
			previewCtx.stroke();

			previewCtx.restore();

			// Create delete button
			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'delete-frame';
			deleteBtn.innerHTML = '×';
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.frames.length > 1) {
					this.frames.splice(index, 1);
					this.currentFrame = Math.min(this.currentFrame, this.frames.length - 1);
					this.updateTimeline();
				}
			});

			// Add click event to preview
			previewCanvas.addEventListener('click', () => {
				this.currentFrame = index;
				this.joints = JSON.parse(JSON.stringify(frame));
				this.updateTimeline();
			});

			frameContainer.appendChild(previewCanvas);
			frameContainer.appendChild(deleteBtn);
			timeline.appendChild(frameContainer);
		});
	}


	play() {
		if (!this.isPlaying) {
			this.isPlaying = true;
			this.animate();
		}
	}

	pause() {
		this.isPlaying = false;
	}

	animate() {
		if (!this.isPlaying) return;

		this.currentFrame = (this.currentFrame + 1) % this.frames.length;
		this.joints = JSON.parse(JSON.stringify(this.frames[this.currentFrame]));
		this.updateTimeline();

		setTimeout(() => {
			requestAnimationFrame(() => this.animate());
		}, 1000 / (this.speed * 2));
	}

	render() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.drawStickman();
		requestAnimationFrame(() => this.render());
	}

	drawStickman() {
		this.ctx.strokeStyle = '#000';
		this.ctx.lineWidth = 4;

		// Draw body line
		this.ctx.beginPath();
		this.ctx.moveTo(this.joints[0].x, this.joints[0].y); // Head to body
		this.ctx.lineTo(this.joints[1].x, this.joints[1].y); // Body to hips
		this.ctx.lineTo(this.joints[2].x, this.joints[2].y);
		this.ctx.stroke();

		// Draw left leg segments
		this.ctx.beginPath();
		this.ctx.moveTo(this.joints[2].x, this.joints[2].y);  // Hips to left knee
		this.ctx.lineTo(this.joints[3].x, this.joints[3].y);  // Left knee to foot
		this.ctx.lineTo(this.joints[4].x, this.joints[4].y);
		this.ctx.stroke();

		// Draw right leg segments
		this.ctx.beginPath();
		this.ctx.moveTo(this.joints[2].x, this.joints[2].y);  // Hips to right knee
		this.ctx.lineTo(this.joints[5].x, this.joints[5].y);  // Right knee to foot
		this.ctx.lineTo(this.joints[6].x, this.joints[6].y);
		this.ctx.stroke();

		// Draw left arm segments
		this.ctx.beginPath();
		this.ctx.moveTo(this.joints[1].x, this.joints[1].y);  // Body to left elbow
		this.ctx.lineTo(this.joints[7].x, this.joints[7].y);  // Left elbow to hand
		this.ctx.lineTo(this.joints[8].x, this.joints[8].y);
		this.ctx.stroke();

		// Draw right arm segments
		this.ctx.beginPath();
		this.ctx.moveTo(this.joints[1].x, this.joints[1].y);  // Body to right elbow
		this.ctx.lineTo(this.joints[9].x, this.joints[9].y);  // Right elbow to hand
		this.ctx.lineTo(this.joints[10].x, this.joints[10].y);
		this.ctx.stroke();

		// Draw head
		this.ctx.beginPath();
		this.ctx.arc(this.joints[0].x, this.joints[0].y, 15, 0, Math.PI * 2);
		this.ctx.stroke();

		// Draw joints
		this.ctx.fillStyle = '#edf3c4';
		this.joints.forEach(joint => {
			this.ctx.beginPath();
			this.ctx.arc(joint.x, joint.y, 4, 0, Math.PI * 2);
			this.ctx.fill();
		});
	}

	createRunningAnimation() {
		const frames = [];
		const basePosition = { x: 200, y: 200 };

		// Running cycle - 8 frames for a complete cycle
		const runningKeyframes = [
			// Frame 1 - Starting position
			[
				{ x: basePosition.x, y: basePosition.y - 40 },      // head
				{ x: basePosition.x, y: basePosition.y },         // body
				{ x: basePosition.x, y: basePosition.y + 25 },      // hips
				{ x: basePosition.x - 30, y: basePosition.y + 50 },   // left knee
				{ x: basePosition.x - 30, y: basePosition.y + 75 },   // left foot
				{ x: basePosition.x + 30, y: basePosition.y + 50 },   // right knee
				{ x: basePosition.x + 30, y: basePosition.y + 75 },   // right foot
				{ x: basePosition.x - 30, y: basePosition.y - 20 },   // left elbow
				{ x: basePosition.x - 45, y: basePosition.y },      // left hand
				{ x: basePosition.x + 30, y: basePosition.y - 20 },   // right elbow
				{ x: basePosition.x + 45, y: basePosition.y }       // right hand
			],
			// Frame 2 - Left leg forward, right leg back
			[
				{ x: basePosition.x, y: basePosition.y - 38 },
				{ x: basePosition.x, y: basePosition.y },
				{ x: basePosition.x, y: basePosition.y + 25 },
				{ x: basePosition.x + 20, y: basePosition.y + 40 },   // left knee forward
				{ x: basePosition.x + 30, y: basePosition.y + 60 },   // left foot forward
				{ x: basePosition.x - 20, y: basePosition.y + 50 },   // right knee back
				{ x: basePosition.x - 40, y: basePosition.y + 70 },   // right foot back
				{ x: basePosition.x + 30, y: basePosition.y - 20 },   // opposite arm swing
				{ x: basePosition.x + 45, y: basePosition.y },
				{ x: basePosition.x - 30, y: basePosition.y - 20 },
				{ x: basePosition.x - 45, y: basePosition.y }
			],
			// Frame 3 - Mid-stride
			[
				{ x: basePosition.x, y: basePosition.y - 40 },
				{ x: basePosition.x, y: basePosition.y },
				{ x: basePosition.x, y: basePosition.y + 25 },
				{ x: basePosition.x + 40, y: basePosition.y + 45 },
				{ x: basePosition.x + 50, y: basePosition.y + 65 },
				{ x: basePosition.x - 40, y: basePosition.y + 45 },
				{ x: basePosition.x - 50, y: basePosition.y + 65 },
				{ x: basePosition.x + 40, y: basePosition.y - 15 },
				{ x: basePosition.x + 55, y: basePosition.y },
				{ x: basePosition.x - 40, y: basePosition.y - 15 },
				{ x: basePosition.x - 55, y: basePosition.y }
			],
			// Frame 4 - Right leg forward, left leg back
			[
				{ x: basePosition.x, y: basePosition.y - 38 },
				{ x: basePosition.x, y: basePosition.y },
				{ x: basePosition.x, y: basePosition.y + 25 },
				{ x: basePosition.x - 20, y: basePosition.y + 50 },
				{ x: basePosition.x - 40, y: basePosition.y + 70 },
				{ x: basePosition.x + 20, y: basePosition.y + 40 },
				{ x: basePosition.x + 30, y: basePosition.y + 60 },
				{ x: basePosition.x - 30, y: basePosition.y - 20 },
				{ x: basePosition.x - 45, y: basePosition.y },
				{ x: basePosition.x + 30, y: basePosition.y - 20 },
				{ x: basePosition.x + 45, y: basePosition.y }
			]
		];

		// Create animation frames
		runningKeyframes.forEach(keyframe => {
			frames.push(keyframe.map((joint, index) => ({
				x: joint.x,
				y: joint.y,
				name: this.joints[index].name
			})));
		});

		// Add reverse frames to complete the cycle
		const reverseFrames = runningKeyframes.slice(1, -1).reverse();
		reverseFrames.forEach(keyframe => {
			frames.push(keyframe.map((joint, index) => ({
				x: joint.x,
				y: joint.y,
				name: this.joints[index].name
			})));
		});

		return frames;
	}

	createDanceAnimation() {
		const frames = [];
		const basePosition = { x: 200, y: 200 };

		// Dance cycle - 10 frames
		const danceKeyframes = [
			// Frame 1 - Starting pose
			[
				{ x: basePosition.x, y: basePosition.y - 40 },
				{ x: basePosition.x, y: basePosition.y },
				{ x: basePosition.x, y: basePosition.y + 25 },
				{ x: basePosition.x - 20, y: basePosition.y + 50 },
				{ x: basePosition.x - 20, y: basePosition.y + 75 },
				{ x: basePosition.x + 20, y: basePosition.y + 50 },
				{ x: basePosition.x + 20, y: basePosition.y + 75 },
				{ x: basePosition.x - 40, y: basePosition.y - 20 },
				{ x: basePosition.x - 60, y: basePosition.y - 40 },
				{ x: basePosition.x + 40, y: basePosition.y - 20 },
				{ x: basePosition.x + 60, y: basePosition.y - 40 }
			],
			// Frame 2 - Arms up, slight bounce
			[
				{ x: basePosition.x, y: basePosition.y - 45 },
				{ x: basePosition.x, y: basePosition.y - 5 },
				{ x: basePosition.x, y: basePosition.y + 20 },
				{ x: basePosition.x - 25, y: basePosition.y + 45 },
				{ x: basePosition.x - 30, y: basePosition.y + 70 },
				{ x: basePosition.x + 25, y: basePosition.y + 45 },
				{ x: basePosition.x + 30, y: basePosition.y + 70 },
				{ x: basePosition.x - 20, y: basePosition.y - 30 },
				{ x: basePosition.x - 20, y: basePosition.y - 60 },
				{ x: basePosition.x + 20, y: basePosition.y - 30 },
				{ x: basePosition.x + 20, y: basePosition.y - 60 }
			],
			// Frame 3 - Hip swing left
			[
				{ x: basePosition.x - 15, y: basePosition.y - 40 },
				{ x: basePosition.x - 10, y: basePosition.y },
				{ x: basePosition.x - 20, y: basePosition.y + 25 },
				{ x: basePosition.x - 40, y: basePosition.y + 50 },
				{ x: basePosition.x - 45, y: basePosition.y + 75 },
				{ x: basePosition.x, y: basePosition.y + 50 },
				{ x: basePosition.x + 10, y: basePosition.y + 75 },
				{ x: basePosition.x - 50, y: basePosition.y - 20 },
				{ x: basePosition.x - 70, y: basePosition.y - 30 },
				{ x: basePosition.x + 30, y: basePosition.y - 20 },
				{ x: basePosition.x + 50, y: basePosition.y - 30 }
			],
			// Frame 4 - Center with arms crossed
			[
				{ x: basePosition.x, y: basePosition.y - 40 },
				{ x: basePosition.x, y: basePosition.y },
				{ x: basePosition.x, y: basePosition.y + 25 },
				{ x: basePosition.x - 20, y: basePosition.y + 50 },
				{ x: basePosition.x - 25, y: basePosition.y + 75 },
				{ x: basePosition.x + 20, y: basePosition.y + 50 },
				{ x: basePosition.x + 25, y: basePosition.y + 75 },
				{ x: basePosition.x + 20, y: basePosition.y - 10 },
				{ x: basePosition.x + 40, y: basePosition.y - 20 },
				{ x: basePosition.x - 20, y: basePosition.y - 10 },
				{ x: basePosition.x - 40, y: basePosition.y - 20 }
			],
			// Frame 5 - Hip swing right
			[
				{ x: basePosition.x + 15, y: basePosition.y - 40 },
				{ x: basePosition.x + 10, y: basePosition.y },
				{ x: basePosition.x + 20, y: basePosition.y + 25 },
				{ x: basePosition.x, y: basePosition.y + 50 },
				{ x: basePosition.x - 10, y: basePosition.y + 75 },
				{ x: basePosition.x + 40, y: basePosition.y + 50 },
				{ x: basePosition.x + 45, y: basePosition.y + 75 },
				{ x: basePosition.x - 30, y: basePosition.y - 20 },
				{ x: basePosition.x - 50, y: basePosition.y - 30 },
				{ x: basePosition.x + 50, y: basePosition.y - 20 },
				{ x: basePosition.x + 70, y: basePosition.y - 30 }
			],
			// Frame 6 - Jump preparation
			[
				{ x: basePosition.x, y: basePosition.y - 35 },
				{ x: basePosition.x, y: basePosition.y + 5 },
				{ x: basePosition.x, y: basePosition.y + 30 },
				{ x: basePosition.x - 20, y: basePosition.y + 60 },
				{ x: basePosition.x - 20, y: basePosition.y + 85 },
				{ x: basePosition.x + 20, y: basePosition.y + 60 },
				{ x: basePosition.x + 20, y: basePosition.y + 85 },
				{ x: basePosition.x - 30, y: basePosition.y - 15 },
				{ x: basePosition.x - 40, y: basePosition.y - 35 },
				{ x: basePosition.x + 30, y: basePosition.y - 15 },
				{ x: basePosition.x + 40, y: basePosition.y - 35 }
			],
			// Frame 7 - Jump up
			[
				{ x: basePosition.x, y: basePosition.y - 60 },
				{ x: basePosition.x, y: basePosition.y - 20 },
				{ x: basePosition.x, y: basePosition.y + 5 },
				{ x: basePosition.x - 15, y: basePosition.y + 25 },
				{ x: basePosition.x - 15, y: basePosition.y + 45 },
				{ x: basePosition.x + 15, y: basePosition.y + 25 },
				{ x: basePosition.x + 15, y: basePosition.y + 45 },
				{ x: basePosition.x - 40, y: basePosition.y - 40 },
				{ x: basePosition.x - 60, y: basePosition.y - 60 },
				{ x: basePosition.x + 40, y: basePosition.y - 40 },
				{ x: basePosition.x + 60, y: basePosition.y - 60 }
			],
			// Frame 8 - Landing preparation
			[
				{ x: basePosition.x, y: basePosition.y - 45 },
				{ x: basePosition.x, y: basePosition.y - 5 },
				{ x: basePosition.x, y: basePosition.y + 20 },
				{ x: basePosition.x - 25, y: basePosition.y + 45 },
				{ x: basePosition.x - 30, y: basePosition.y + 70 },
				{ x: basePosition.x + 25, y: basePosition.y + 45 },
				{ x: basePosition.x + 30, y: basePosition.y + 70 },
				{ x: basePosition.x - 35, y: basePosition.y - 25 },
				{ x: basePosition.x - 45, y: basePosition.y - 45 },
				{ x: basePosition.x + 35, y: basePosition.y - 25 },
				{ x: basePosition.x + 45, y: basePosition.y - 45 }
			],
			// Frame 9 - Landing
			[
				{ x: basePosition.x, y: basePosition.y - 35 },
				{ x: basePosition.x, y: basePosition.y + 5 },
				{ x: basePosition.x, y: basePosition.y + 30 },
				{ x: basePosition.x - 30, y: basePosition.y + 55 },
				{ x: basePosition.x - 35, y: basePosition.y + 80 },
				{ x: basePosition.x + 30, y: basePosition.y + 55 },
				{ x: basePosition.x + 35, y: basePosition.y + 80 },
				{ x: basePosition.x - 25, y: basePosition.y - 15 },
				{ x: basePosition.x - 35, y: basePosition.y - 35 },
				{ x: basePosition.x + 25, y: basePosition.y - 15 },
				{ x: basePosition.x + 35, y: basePosition.y - 35 }
			],
			// Frame 10 - Return to starting pose
			[
				{ x: basePosition.x, y: basePosition.y - 40 },
				{ x: basePosition.x, y: basePosition.y },
				{ x: basePosition.x, y: basePosition.y + 25 },
				{ x: basePosition.x - 20, y: basePosition.y + 50 },
				{ x: basePosition.x - 20, y: basePosition.y + 75 },
				{ x: basePosition.x + 20, y: basePosition.y + 50 },
				{ x: basePosition.x + 20, y: basePosition.y + 75 },
				{ x: basePosition.x - 40, y: basePosition.y - 20 },
				{ x: basePosition.x - 60, y: basePosition.y - 40 },
				{ x: basePosition.x + 40, y: basePosition.y - 20 },
				{ x: basePosition.x + 60, y: basePosition.y - 40 }
			]
		];

		danceKeyframes.forEach(keyframe => {
			frames.push(keyframe.map((joint, index) => ({
				x: joint.x,
				y: joint.y,
				name: this.joints[index].name
			})));
		});

		return frames;
	}

	exportAnimation() {
		// Create a temporary canvas for recording
		const recordCanvas = document.createElement('canvas');
		recordCanvas.width = this.canvas.width;
		recordCanvas.height = this.canvas.height;
		const recordCtx = recordCanvas.getContext('2d');

		// Setup MediaRecorder with lower fps for slower animation
		const stream = recordCanvas.captureStream(20); // Reduced from 30 to 24 FPS
		const mediaRecorder = new MediaRecorder(stream, {
			mimeType: 'video/webm;codecs=vp9'
		});

		const chunks = [];
		mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
		mediaRecorder.onstop = () => {
			const blob = new Blob(chunks, { type: 'video/webm' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'stickman-animation.webm';
			a.click();
			URL.revokeObjectURL(url);
		};

		// Start recording
		mediaRecorder.start();

		// Render each frame
		let currentFrame = 0;
		const renderFrame = () => {
			if (currentFrame >= this.frames.length) {
				mediaRecorder.stop();
				return;
			}

			// Clear and draw frame
			recordCtx.fillStyle = '#ffffff';
			recordCtx.fillRect(0, 0, recordCanvas.width, recordCanvas.height);

			// Save current state
			const originalJoints = [...this.joints];

			// Set joints to current frame
			this.joints = JSON.parse(JSON.stringify(this.frames[currentFrame]));

			// Create a temporary context object
			const tempContext = {
				ctx: recordCtx,
				joints: this.joints,
				canvas: recordCanvas,
				drawStickman: this.drawStickman
			};

			// Draw frame using the temporary context
			this.drawStickman.call(tempContext);

			// Restore original state
			this.joints = originalJoints;

			currentFrame++;
			// Increased delay between frames (120ms instead of 33ms)
			setTimeout(() => requestAnimationFrame(renderFrame), 150);
		};

		renderFrame();
	}
}

// Initialize the animator when the page loads
window.addEventListener('load', () => {
	const animator = new StickmanAnimator();
});