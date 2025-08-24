requirejs.config({
    baseUrl: "lib",
    paths: {
        activity: "../js"
    },
    waitSeconds: 30,  // Increase timeout
    shim: {
        'tf': {
            exports: 'tf'
        },
        'posenet': {
            deps: ['tf'],
            exports: 'posenet'
        }
    }
});

// Wait for TensorFlow.js and PoseNet to load before starting the activity
function checkLibrariesLoaded() {
    if (typeof window.tf !== 'undefined' && typeof window.posenet !== 'undefined') {
        console.log('TensorFlow.js and PoseNet loaded successfully');
        requirejs(["activity/activity"]);
    } else {
        console.log('Waiting for TensorFlow.js and PoseNet to load...');
        setTimeout(checkLibrariesLoaded, 100);
    }
}

// Start checking after a brief delay to allow scripts to load
setTimeout(checkLibrariesLoaded, 500);
