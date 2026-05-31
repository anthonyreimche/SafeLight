interface RatingProps {
  value: number;
  onChange?: (rating: number) => void;
  size?: "sm" | "md";
}

export function Rating({ value, onChange, size = "sm" }: RatingProps) {
  const starSize = size === "sm" ? "text-xs" : "text-sm";

  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          onClick={() => onChange?.(value === star ? 0 : star)}
          className={`${starSize} ${
            star <= value ? "text-rating" : "text-text-muted"
          } ${onChange ? "cursor-pointer hover:text-rating" : "cursor-default"}`}
          disabled={!onChange}
        >
          {star <= value ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}
