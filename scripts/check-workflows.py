#!/usr/bin/env python3
"""Reject GitHub workflow files with duplicate mapping keys (GitHub refuses them; PyYAML does not)."""
import sys, glob, yaml
class Strict(yaml.SafeLoader):
    pass
def construct_mapping(loader, node, deep=False):
    seen = set()
    for k, _ in node.value:
        key = loader.construct_object(k, deep=deep)
        if key in seen:
            raise yaml.constructor.ConstructorError(None, None, f"duplicate key {key!r}", k.start_mark)
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)
Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)
bad = 0
for f in sorted(glob.glob(".github/workflows/*.yml")):
    try:
        yaml.load(open(f), Loader=Strict); print("ok  ", f)
    except Exception as e:
        bad += 1; print("FAIL", f, e)
sys.exit(1 if bad else 0)
