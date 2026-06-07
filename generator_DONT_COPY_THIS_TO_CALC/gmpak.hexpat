#pragma endian little

enum EntryType : u8 {
    META = 0,
    VIDEO_CPQOI = 1,
    SUBTITLE = 2,
    AUDIO = 3,
    VIDEO_GINT_IMAGE = 4
};

struct Header {
    char magic[4];      // "GMPK"
    u16 version;        // 1
    u32 toc_offset;     // Absolute file offset of the Table of Contents
};

struct GintImagePayload {
    u8  profile;        // fxconv/gint image profile
    u16 width;
    u16 height;
    u16 stride;
    u8  color_count;
    u16 palette_len;
    u32 data_len;

    u8 palette[palette_len];
    u8 data[data_len];
};

struct TocEntry {
    char name[16];      // zero-terminated ASCII
    EntryType type;
    u32 offset;         // Absolute file offset to payload bytes
    u32 size;           // Total chunk size

    // ---- Dynamic Overlays ----
    if (type == EntryType::META) {
        char text_data[size] @ offset;
    } else if (type == EntryType::VIDEO_CPQOI) {
        u8 cpqoi_data[size] @ offset;
    } else if (type == EntryType::SUBTITLE) {
        char subtitle_text[size] @ offset;
    } else if (type == EntryType::VIDEO_GINT_IMAGE) {
        GintImagePayload gint_image @ offset;
    } else {
        u8 payload[size] @ offset;
    }
};

struct Toc {
    u32 count;
    TocEntry entries[count];
};

Header header @ 0x00;
Toc toc @ header.toc_offset;