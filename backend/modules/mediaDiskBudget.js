'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createMediaDiskBudget({ minFreeBytes = 2 * 1024 ** 3,
    statfs = root => fs.statfsSync(root), deviceFor = root => fs.statSync(root).dev } = {}) {
    const reservations = new Set();
    function ensure(root, device, additional = 0) {
        const stats = statfs(root);
        const available = stats.bavail * stats.bsize;
        const remaining = [...reservations].filter(r => r.device === device).reduce((n, r) => n + r.maxBytes - r.writtenBytes, 0);
        if (!Number.isSafeInteger(available) || available - remaining - additional < minFreeBytes) {
            throw Object.assign(new Error('Insufficient space for media reservation'), { code: 'MEDIA_DISK_FULL' });
        }
    }
    return {
        reserve(root, maxBytes) {
            if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid media disk reservation');
            const device = deviceFor(root);
            ensure(root, device, maxBytes);
            const reservation = { device, maxBytes, writtenBytes: 0 };
            reservations.add(reservation);
            return {
                check(writtenBytes) {
                    if (!reservations.has(reservation)) throw new Error('Media disk reservation released');
                    if (!Number.isSafeInteger(writtenBytes) || writtenBytes < 0 || writtenBytes > maxBytes) {
                        throw Object.assign(new Error('Media disk usage exceeded reservation'), { code: 'MEDIA_DISK_LIMIT' });
                    }
                    reservation.writtenBytes = writtenBytes;
                    ensure(root, device);
                },
                release() { reservations.delete(reservation); },
            };
        },
        snapshot: () => ({ active: reservations.size, remainingBytes: [...reservations].reduce((n, r) => n + r.maxBytes - r.writtenBytes, 0) }),
    };
}
function directoryBytes(directory) {
    let bytes = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        try {
            if (entry.isDirectory()) bytes += directoryBytes(file);
            else if (entry.isFile()) bytes += fs.statSync(file).size;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return bytes;
}
const mediaDiskBudget = createMediaDiskBudget();
module.exports = { createMediaDiskBudget, mediaDiskBudget, directoryBytes };
