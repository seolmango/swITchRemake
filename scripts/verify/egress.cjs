'use strict';
// This preload is audit-only. Docker's internal network is the primary firewall.
// Deny accidental HTTP/SMTP/database configuration before DNS or TCP connection.
if (process.env.AUDIT_STACK !== 'true' || (process.env.APP_ENV !== 'audit' && process.env.AUDIT_UNIT !== 'true')) {
    throw new Error('Audit egress guard requires a disposable audit environment');
}
const allowed = new Set(['postgres', 'redis', 'mailpit', 'match', 'cluster', 'web', 'localhost', '127.0.0.1', '::1']);
const net = require('node:net');
// HTTP clients may resolve the service before calling Socket.connect. Resolve
// only these exact Docker DNS names; never permit a whole private subnet.
const { spawnSync } = require('node:child_process');
const lookup = spawnSync(process.execPath, ['-e', `
const dns=require('node:dns').promises;
Promise.allSettled(${JSON.stringify([...allowed].filter(host => !net.isIP(host)))}.map(host=>dns.lookup(host,{all:true})))
 .then(results=>console.log(JSON.stringify(results.flatMap(r=>r.status==='fulfilled'?r.value.map(v=>v.address):[]))));
`], { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 });
if (lookup.error || lookup.status !== 0) throw new Error('Audit service DNS validation failed');
for (const address of JSON.parse(lookup.stdout)) {
    if (!net.isIP(address)) throw new Error('Audit service DNS returned a non-IP address');
    allowed.add(address);
    if (net.isIP(address) === 4) allowed.add(`::ffff:${address}`);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const options = typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0]
        : Array.isArray(args[0]) ? args[0][0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    if (options && typeof options === 'object' && !options.path) {
        const host = options.host || 'localhost';
        if (!allowed.has(host)) throw new Error('AUDIT_EGRESS_DENIED: disallowed socket destination');
    }
    return connect.apply(this, args);
};
