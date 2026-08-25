'use strict';

function findAcceptedTtsEvent(database, videoId, eventId) {
  if (!database || typeof database.getVideo !== 'function' || !videoId || !eventId) return null;
  const video = database.getVideo(videoId);
  if (!video || !Array.isArray(video.script)) return null;
  const event = video.script.find(candidate => candidate.id === eventId);
  if (!event || event.validationStatus !== 'accepted' || event.ttsEligible !== true) return null;
  return event;
}

module.exports = { findAcceptedTtsEvent };
