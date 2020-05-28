/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const { Storage } = require('@google-cloud/storage');
const gcs = new Storage();
const path = require('path');
const sharp = require('sharp');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

const THUMB_MAX_WIDTH = 200;
const THUMB_MAX_HEIGHT = 200;

/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * Sharp.
 */
exports.generateThumbnail = functions.storage.object().onFinalize((object) => {
	const fileBucket = object.bucket; // The Storage bucket that contains the file.
	const filePath = object.name; // File path in the bucket.
	const contentType = object.contentType; // File content type.

	// Exit if this is triggered on a file that is not an image.
	if (!contentType.startsWith('image/')) {
		console.log('This is not an image.');
		return null;
	}

	// Get the file name.
	const fileName = path.basename(filePath);
	// Exit if the image is already a thumbnail.
	if (fileName.startsWith('thumb_')) {
		console.log('Already a Thumbnail.');
		return null;
	}

	// Download file from bucket.
	const bucket = gcs.bucket(fileBucket);

	const metadata = {
		contentType: contentType,
	};
	// We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
	const thumbFileName = `thumb_${fileName}`;
	const thumbFilePath = path.join(path.dirname(filePath), thumbFileName);
	// Create write stream for uploading thumbnail
	const thumbnailUploadStream = bucket.file(thumbFilePath).createWriteStream({ metadata });

	// Create Sharp pipeline for resizing the image and use pipe to read from bucket read stream
	const pipeline = sharp();
	pipeline.rotate().resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT).pipe(thumbnailUploadStream);

	bucket.file(filePath).createReadStream().pipe(pipeline);

	const saveToDatabase = async () => {
		const fileDir = path.dirname(filePath);
		let nameParts = fileDir.split('/');
		let userId;
		// Get the user id from the filePath
		if (nameParts[0] === 'profile_photos') {
			userId = nameParts[1];
		}
		// Save the Signed URLs for the thumbnail and original image to the user profile.
		const config = {
			action: 'read',
			expires: '03-01-2500',
		};
		const thumbFile = bucket.file(thumbFilePath);
		const file = bucket.file(filePath);
		const results = await Promise.all([thumbFile.getSignedUrl(config), file.getSignedUrl(config)]);
		console.log('Got Signed URLs.');
		const thumbResult = results[0];
		const originalResult = results[1];
		const thumbFileUrl = thumbResult[0];
		const fileUrl = originalResult[0];
		// Add the URLs to the Database
		await admin.database().ref(`users/${userId}/profile/photo`).set({ path: fileUrl, thumbnail: thumbFileUrl });
		console.log('Thumbnail URLs saved to database.');
	};

	return new Promise((resolve, reject) =>
		thumbnailUploadStream
			.on('finish', () => {
				saveToDatabase();
				resolve;
			})
			.on('error', reject)
	);
});
