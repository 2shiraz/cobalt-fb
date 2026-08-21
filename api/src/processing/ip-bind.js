import ipaddr from "ipaddr.js";

export function normalizeIPBind(value) {
    const ip = ipaddr.parse(value);
    const prefix = ip.kind() === 'ipv4' ? 24 : 64;
    const bytes = ip.toByteArray();

    for (let index = Math.ceil(prefix / 8); index < bytes.length; index++) {
        bytes[index] = 0;
    }

    if (prefix % 8) {
        const index = Math.floor(prefix / 8);
        bytes[index] &= 0xff << (8 - (prefix % 8));
    }

    return `${ipaddr.fromByteArray(bytes).toString()}/${prefix}`;
}

export function isIPInBind(value, binding) {
    try {
        const ip = ipaddr.parse(value);
        const [network, prefix] = ipaddr.parseCIDR(binding);
        return ip.kind() === network.kind() && ip.match([network, prefix]);
    } catch {
        return false;
    }
}