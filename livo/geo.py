"""Optional offline geography; trust forwarding headers only behind loopback."""
from functools import lru_cache
import ipaddress
import os
from pathlib import Path
import re

GEO = Path(os.environ.get('LIVO_GEO_DIR', str(Path(__file__).resolve().parents[1] / 'var/geo')))

def client_ip(peer, headers):
    try:
        address = ipaddress.ip_address(peer)
        if address.is_loopback:
            forwarded = headers.get('CF-Connecting-IP')
            if not forwarded:
                return None
            address = ipaddress.ip_address(forwarded)
            if address.version == 4 and address.is_reserved and headers.get('CF-Connecting-IPv6'):
                address = ipaddress.ip_address(headers['CF-Connecting-IPv6'])
        if getattr(address, 'ipv4_mapped', None):
            address = address.ipv4_mapped
        return str(address) if address.is_global else None
    except ValueError:
        return None

@lru_cache(maxsize=1)
def geo_readers():
    import ip2region.util as util
    import ip2region.searcher as xdb
    readers = {}
    for version, kind in ((4, util.IPv4), (6, util.IPv6)):
        path = GEO / f'ip2region_v{version}.xdb'
        util.verify_from_file(str(path))
        readers[version] = xdb.new_with_buffer(kind, util.load_content_from_file(str(path)))
    return readers

@lru_cache(maxsize=4096)
def location(ip):
    try:
        raw = geo_readers()[ipaddress.ip_address(ip).version].search(ip)
        fields = [v if v not in ('0', '-', 'null') else '' for v in raw.split('|')]
        fields += [''] * (5 - len(fields))
        country, region, city, isp, code = fields[:5]
        return dict(country=country, region=region, city=city, countryCode=code.upper() if re.fullmatch('[A-Za-z]{2}', code) else '')
    except (ImportError, OSError, ValueError, IndexError):
        return dict(country='', region='', city='', countryCode='')
