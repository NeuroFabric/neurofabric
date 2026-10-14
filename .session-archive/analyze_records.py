import json
with open('verification/scenarios/C-structured-audit/records.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

print(f"Type of root: {type(data)}")
if isinstance(data, list):
    print(f"Total records: {len(data)}")
    all_fields = set()
    for item in data:
        if isinstance(item, dict):
            all_fields.update(item.keys())
    
    print(f"All unique fields found: {sorted(list(all_fields))}")
    
    missing_fields_per_record = []
    null_counts = {field: 0 for field in all_fields}
    field_types = {field: set() for field in all_fields}
    
    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            print(f"Record {idx} is not a dict: {type(item)}")
            continue
        item_fields = set(item.keys())
        missing = all_fields - item_fields
        if missing:
            missing_fields_per_record.append((idx, missing))
        for field in all_fields:
            val = item.get(field, None)
            if val is None:
                null_counts[field] += 1
            field_types[field].add(type(val).__name__)
            
    print(f"Records with missing fields: {len(missing_fields_per_record)}")
    for idx, missing in missing_fields_per_record[:10]:
        print(f"  Record {idx} missing: {missing}")
        
    print("\nNull counts per field:")
    for field, count in null_counts.items():
        print(f"  {field}: {count}")
        
    print("\nField types per field:")
    for field, types in field_types.items():
        print(f"  {field}: {types}")
else:
    print("Root is not a list")
