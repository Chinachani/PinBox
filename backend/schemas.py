from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


MAX_QUANTITY = 2_147_483_647
Quantity = Annotated[int, Field(strict=True, ge=0, le=MAX_QUANTITY)]
Price = Annotated[float, Field(strict=True, ge=0, le=1e12, allow_inf_nan=False)]


class MaterialCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    code: str = Field(min_length=1, max_length=128, pattern=r"^[^/\x00-\x1f]+$")
    model: str = Field(min_length=1, max_length=2000)
    category: str = "未分类"
    brand: str = ""
    package: str = ""
    quantity: Quantity = 0
    unit: str = "个"
    price: Price = 0.0
    location: str = ""
    use_case: str = ""
    batch: str = "手动录入"
    order_date: str = ""
    min_stock: Quantity = 0
    remark: str = ""

    @field_validator("code")
    @classmethod
    def uppercase_code(cls, value):
        return value.upper()


class MaterialUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    category: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    package: Optional[str] = None
    quantity: Optional[Quantity] = None
    unit: Optional[str] = None
    price: Optional[Price] = None
    location: Optional[str] = None
    use_case: Optional[str] = None
    batch: Optional[str] = None
    order_date: Optional[str] = None
    min_stock: Optional[Quantity] = None
    remark: Optional[str] = None


class StockChange(BaseModel):
    delta: int = Field(strict=True, ge=-MAX_QUANTITY, le=MAX_QUANTITY)
    reason: Optional[str] = "手动调整"
    project: Optional[str] = ""


class LocationCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=256)
    note: str = ""


class LocationUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: Optional[str] = Field(default=None, min_length=1, max_length=256)
    note: Optional[str] = None


class BackupMaterial(MaterialCreate):
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class BackupLog(BaseModel):
    id: Optional[int] = Field(default=None, ge=1)
    material_code: str
    change_type: Literal["in", "out", "adjust", "init", "import"]
    delta: int = Field(strict=True, ge=-MAX_QUANTITY, le=MAX_QUANTITY)
    remaining: Quantity
    reason: str = ""
    project: str = ""
    created_at: Optional[str] = None


class BackupLocation(LocationCreate):
    id: Optional[int] = Field(default=None, ge=1)
    created_at: Optional[str] = None


class Backup(BaseModel):
    materials: list[BackupMaterial]
    stock_logs: list[BackupLog] = Field(default_factory=list)
    locations: list[BackupLocation] = Field(default_factory=list)

    def validate_references(self):
        codes = [m.code for m in self.materials]
        names = [loc.name for loc in self.locations]
        if len(codes) != len(set(codes)) or len(names) != len(set(names)):
            raise ValueError("备份包含重复物料编号或库位")
        known = set(codes)
        for log in self.stock_logs:
            log.material_code = log.material_code.strip().upper()
            if log.material_code not in known:
                raise ValueError("流水关联了不存在的物料")
        for rows in (self.stock_logs, self.locations):
            ids = [r.id for r in rows if r.id is not None]
            if len(ids) != len(set(ids)):
                raise ValueError("备份包含重复记录 ID")
            next_id = max(ids, default=0)
            for row in rows:
                if row.id is None:
                    next_id += 1
                    row.id = next_id
        return self
